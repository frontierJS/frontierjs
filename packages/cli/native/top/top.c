// native/top/top.c — `fli top` where cargo is not installed. src/main.rs is the
// same monitor in Rust and the one fli builds when it can; a change to either
// is made to both, checked against a vtop screen.
// Build: cc -O2 -Wall -o fli-top-c top.c
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

// blessed's 256-colour matches for parallax's #a537fd and #00ebbe, so fli top looks
// like vtop does on the same terminal rather than like the theme's hex values
#define PURPLE 135
#define TEAL 43
#define WHITE 7
#define BLACK 0
#define DEF -1

#define HIST 4096
#define NAME_LEN 32
#define KEY_PGUP 1001
#define KEY_PGDN 1002

typedef struct { uint32_t ch; int16_t fg, bg; uint8_t bold; } Cell;
typedef struct { int pid; unsigned long long ticks, start; } PSamp;
typedef struct { char name[NAME_LEN]; double cpu, mem; int count; } Group;

static int cols, rows;
static Cell *back, *front;
static char *out;
static size_t outlen, outcap;
static volatile sig_atomic_t quit_flag, resize_flag;
static struct termios orig_tio;

static long hz, page_kb;
static int ncpu;
static char host[64];

static unsigned long long cpu_busy[32], cpu_total[32];
static int cpu_n;
static unsigned long long mem_total_kb;
static uint8_t hist_cpu[HIST], hist_mem[HIST];
static int hist_n, cur_cpu, cur_mem;

static PSamp *prev, *curr;
static int nprev, ncurr, cap_prev, cap_curr;
static double last_scan;
static Group *groups;
static int ngroups, cap_groups, sort_mem;
static int sel, scroll, list_rows = 1;
static char sel_name[NAME_LEN];

static char flash[128];
static double flash_until;

static double mono(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static int slurp(const char *path, char *buf, int cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  int n = read(fd, buf, cap - 1);
  close(fd);
  if (n < 0) return -1;
  buf[n] = 0;
  return n;
}

// ---- output ----

static void ob(const void *s, size_t n) {
  if (outlen + n > outcap) {
    outcap = (outlen + n) * 2;
    out = realloc(out, outcap);
  }
  memcpy(out + outlen, s, n);
  outlen += n;
}

static void obf(const char *fmt, ...) {
  char tmp[64];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  ob(tmp, n);
}

static void ob_utf8(uint32_t c) {
  char s[3];
  if (c < 0x80) { s[0] = c; ob(s, 1); }
  else if (c < 0x800) { s[0] = 0xC0 | c >> 6; s[1] = 0x80 | (c & 0x3F); ob(s, 2); }
  else { s[0] = 0xE0 | c >> 12; s[1] = 0x80 | ((c >> 6) & 0x3F); s[2] = 0x80 | (c & 0x3F); ob(s, 3); }
}

static void ob_flush(void) {
  size_t off = 0;
  while (off < outlen) {
    ssize_t n = write(1, out + off, outlen - off);
    if (n < 0) { if (errno == EINTR) continue; break; }
    off += n;
  }
  outlen = 0;
}

static void sgr_color(int c, int base) {
  if (c < 0) return;
  if (c < 8) obf(";%d", base + c);
  else if (c < 16) obf(";%d", base + 60 + c - 8);
  else obf(";%d;5;%d", base + 8, c);
}

// Writes only the cells that changed since the last frame, in one write().
static void present(void) {
  int cx = -1, cy = -1, fg = -2, bg = -2, bold = -1;
  for (int y = 0; y < rows; y++) {
    for (int x = 0; x < cols; x++) {
      Cell *b = &back[y * cols + x], *f = &front[y * cols + x];
      if (b->ch == f->ch && b->fg == f->fg && b->bg == f->bg && b->bold == f->bold) continue;
      if (cx != x || cy != y) obf("\x1b[%d;%dH", y + 1, x + 1);
      if (b->fg != fg || b->bg != bg || b->bold != bold) {
        ob("\x1b[0", 3);
        if (b->bold) ob(";1", 2);
        sgr_color(b->fg, 30);
        sgr_color(b->bg, 40);
        ob("m", 1);
        fg = b->fg; bg = b->bg; bold = b->bold;
      }
      ob_utf8(b->ch);
      *f = *b;
      cx = x + 1; cy = y;
    }
  }
  ob_flush();
}

static void put(int x, int y, uint32_t ch, int fg, int bg, int bold) {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return;
  Cell *c = &back[y * cols + x];
  c->ch = ch; c->fg = fg; c->bg = bg; c->bold = bold;
}

static int textn(int x, int y, const char *s, int max, int fg, int bg, int bold) {
  for (; *s && max > 0; s++, x++, max--) put(x, y, (unsigned char)*s < 128 ? (unsigned char)*s : '?', fg, bg, bold);
  return x;
}

static int text(int x, int y, const char *s, int fg, int bg, int bold) {
  return textn(x, y, s, 1 << 30, fg, bg, bold);
}

// ---- terminal ----

static void term_restore(void) {
  tcsetattr(0, TCSAFLUSH, &orig_tio);
  static const char s[] = "\x1b[0m\x1b[?25h\x1b[?1049l";
  if (write(1, s, sizeof s - 1) < 0) {}
}

static void on_signal(int s) {
  if (s == SIGWINCH) resize_flag = 1;
  else quit_flag = 1;
}

static void resize(void) {
  struct winsize ws;
  if (ioctl(1, TIOCGWINSZ, &ws) == 0 && ws.ws_col && ws.ws_row) { cols = ws.ws_col; rows = ws.ws_row; }
  else { cols = 80; rows = 24; }
  back = realloc(back, sizeof(Cell) * cols * rows);
  front = realloc(front, sizeof(Cell) * cols * rows);
  for (int i = 0; i < cols * rows; i++) front[i].ch = 0xFFFFFFFF;
  ob("\x1b[0m\x1b[2J", 8);
}

// ---- sensors ----

// CPU % over roughly the last second, like os-utils' cpuUsage that vtop uses.
static int sample_cpu(int window) {
  char buf[512];
  if (slurp("/proc/stat", buf, sizeof buf) <= 0) return 0;
  unsigned long long v[8] = {0}, total = 0;
  char *p = buf + 3;
  for (int i = 0; i < 8; i++) { v[i] = strtoull(p, &p, 10); total += v[i]; }
  int slot = cpu_n % 32;
  cpu_busy[slot] = total - v[3] - v[4];
  cpu_total[slot] = total;
  cpu_n++;
  int back_n = window < cpu_n - 1 ? window : cpu_n - 1;
  if (back_n <= 0) return 0;
  int old = (cpu_n - 1 - back_n) % 32;
  unsigned long long dt = total - cpu_total[old], db = cpu_busy[slot] - cpu_busy[old];
  return dt ? (int)(100.0 * db / dt) : 0;
}

static int sample_mem(void) {
  char buf[512];
  if (slurp("/proc/meminfo", buf, sizeof buf) <= 0) return 0;
  char *t = strstr(buf, "MemTotal:"), *a = strstr(buf, "MemAvailable:");
  if (!t || !a) return 0;
  mem_total_kb = strtoull(t + 9, NULL, 10);
  unsigned long long avail = strtoull(a + 13, NULL, 10);
  return mem_total_kb ? (int)(100.0 * (mem_total_kb - avail) / mem_total_kb + 0.5) : 0;
}

// Group name is the comm cut at '/', as vtop does, so kworker/0:1 counts as kworker.
static int read_stat(const char *pid, char *name, unsigned long long *ticks, unsigned long long *start, unsigned long long *rss) {
  char path[64], buf[1024];
  snprintf(path, sizeof path, "/proc/%s/stat", pid);
  if (slurp(path, buf, sizeof buf) <= 0) return -1;
  char *l = strchr(buf, '('), *r = strrchr(buf, ')');
  if (!l || !r || r < l) return -1;
  int n = r - l - 1;
  if (n >= NAME_LEN) n = NAME_LEN - 1;
  memcpy(name, l + 1, n);
  name[n] = 0;
  char *slash = strchr(name, '/');
  if (slash) *slash = 0;
  // f[i] is stat field i + 3
  unsigned long long f[22];
  char *p = r + 2;
  for (int i = 0; i < 22; i++) {
    while (*p == ' ') p++;
    f[i] = strtoull(p, NULL, 10);
    while (*p && *p != ' ') p++;
  }
  *ticks = f[11] + f[12];
  *start = f[19];
  *rss = f[21];
  return 0;
}

static int cmp_pid(const void *a, const void *b) {
  return ((const PSamp *)a)->pid - ((const PSamp *)b)->pid;
}

static void scan_procs(double now) {
  DIR *d = opendir("/proc");
  if (!d) return;
  double dt = last_scan > 0 ? now - last_scan : 0;
  last_scan = now;
  ncurr = 0;
  ngroups = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!isdigit((unsigned char)e->d_name[0])) continue;
    char name[NAME_LEN];
    unsigned long long ticks, start, rss;
    if (read_stat(e->d_name, name, &ticks, &start, &rss)) continue;
    int pid = atoi(e->d_name);
    double cpu = 0;
    if (dt > 0) {
      PSamp key = {pid, 0, 0};
      PSamp *p = nprev ? bsearch(&key, prev, nprev, sizeof *prev, cmp_pid) : NULL;
      unsigned long long used = p && p->start == start ? ticks - p->ticks : ticks;
      cpu = used / (double)hz / dt * 100.0 / ncpu;
    }
    double mem = mem_total_kb ? rss * page_kb * 100.0 / mem_total_kb : 0;

    Group *g = NULL;
    for (int i = 0; i < ngroups; i++) if (!strcmp(groups[i].name, name)) { g = &groups[i]; break; }
    if (!g) {
      if (ngroups == cap_groups) { cap_groups = cap_groups ? cap_groups * 2 : 256; groups = realloc(groups, sizeof *groups * cap_groups); }
      g = &groups[ngroups++];
      memcpy(g->name, name, NAME_LEN);
      g->cpu = g->mem = 0;
      g->count = 0;
    }
    g->cpu += cpu;
    g->mem += mem;
    g->count++;

    if (ncurr == cap_curr) { cap_curr = cap_curr ? cap_curr * 2 : 1024; curr = realloc(curr, sizeof *curr * cap_curr); }
    curr[ncurr++] = (PSamp){pid, ticks, start};
  }
  closedir(d);
  qsort(curr, ncurr, sizeof *curr, cmp_pid);
  PSamp *t = prev; prev = curr; curr = t;
  int c = cap_prev; cap_prev = cap_curr; cap_curr = c;
  nprev = ncurr;
}

static int cmp_group(const void *a, const void *b) {
  const Group *x = a, *y = b;
  double kx = sort_mem ? x->mem : x->cpu, ky = sort_mem ? y->mem : y->cpu;
  if (kx != ky) return kx < ky ? 1 : -1;
  return strcmp(x->name, y->name);
}

static void select_row(int i) {
  if (i >= ngroups) i = ngroups - 1;
  if (i < 0) i = 0;
  sel = i;
  if (ngroups) memcpy(sel_name, groups[i].name, NAME_LEN);
}

// At the top the cursor stays put, so the view keeps showing the busiest rows.
// Once moved it follows its process: a refresh that adds a group above would
// otherwise slide another process under it, and dd would kill that one.
static void sort_groups(void) {
  qsort(groups, ngroups, sizeof *groups, cmp_group);
  if (sel > 0) {
    for (int i = 0; i < ngroups; i++) {
      if (!strcmp(groups[i].name, sel_name)) { sel = i; return; }
    }
  }
  select_row(sel);
}

// SIGTERM every process in the group, as vtop's `killall <name>` does.
static void kill_group(const char *target, double now) {
  DIR *d = opendir("/proc");
  if (!d) return;
  int ok = 0, denied = 0;
  pid_t self = getpid();
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!isdigit((unsigned char)e->d_name[0])) continue;
    char name[NAME_LEN];
    unsigned long long a, b, c;
    if (read_stat(e->d_name, name, &a, &b, &c) || strcmp(name, target)) continue;
    pid_t pid = atoi(e->d_name);
    if (pid == self) continue;
    if (kill(pid, SIGTERM) == 0) ok++;
    else denied++;
  }
  closedir(d);
  if (!ok && !denied) snprintf(flash, sizeof flash, "%s: no such process ", target);
  else if (denied) snprintf(flash, sizeof flash, "%s: %d killed, %d not permitted ", target, ok, denied);
  else snprintf(flash, sizeof flash, "%s: SIGTERM sent to %d ", target, ok);
  flash_until = now + 3;
}

// ---- drawing ----

static void draw_box(int x, int y, int w, int h, const char *label) {
  if (w < 2 || h < 2) return;
  put(x, y, 0x250C, TEAL, DEF, 0);
  put(x + w - 1, y, 0x2510, TEAL, DEF, 0);
  put(x, y + h - 1, 0x2514, TEAL, DEF, 0);
  put(x + w - 1, y + h - 1, 0x2518, TEAL, DEF, 0);
  for (int i = 1; i < w - 1; i++) {
    put(x + i, y, 0x2500, TEAL, DEF, 0);
    put(x + i, y + h - 1, 0x2500, TEAL, DEF, 0);
  }
  for (int j = 1; j < h - 1; j++) {
    put(x, y + j, 0x2502, TEAL, DEF, 0);
    put(x + w - 1, y + j, 0x2502, TEAL, DEF, 0);
  }
  if (label) textn(x + 2, y, label, w - 3, DEF, DEF, 0);
}

static void draw_chart(int x, int y, int w, int h, const char *label, const uint8_t *hist, int cur) {
  static const uint8_t bit[4][2] = {{0x01, 0x08}, {0x02, 0x10}, {0x04, 0x20}, {0x40, 0x80}};
  static uint8_t *dots;
  static int dots_cap;
  draw_box(x, y, w, h, label);
  int cw = w - 3, ch = h - 2;
  if (cw < 1 || ch < 1) return;
  if (cw * ch > dots_cap) { dots_cap = cw * ch; dots = realloc(dots, dots_cap); }
  memset(dots, 0, cw * ch);
  int pw = cw * 2, ph = ch * 4;
  int n = hist_n < pw ? hist_n : pw;
  for (int i = 0; i < n; i++) {
    int v = hist[(hist_n - n + i) % HIST];
    int px = pw - n + i;
    int top = ph - (int)((ph + 1) / 100.0 * v) - 1;
    if (top < 0) top = 0;
    for (int py = top; py < ph; py++) dots[(py / 4) * cw + px / 2] |= bit[py % 4][px % 2];
  }
  for (int cy = 0; cy < ch; cy++) {
    for (int cx = 0; cx < cw; cx++) {
      uint8_t d = dots[cy * cw + cx];
      put(x + 1 + cx, y + 1 + cy, d ? 0x2800 + d : ' ', PURPLE, DEF, 0);
    }
  }
  if (cw >= 4) {
    char pct[8];
    snprintf(pct, sizeof pct, "%3d%%", cur);
    text(x + 1 + cw - 4, y + 1, pct, WHITE, DEF, 0);
  }
}

// " value" padded and cut to the column width, as vtop's table does.
static void cell(int x, int y, const char *s, int width, int bg, int bold) {
  if (width <= 0) return;
  put(x, y, ' ', DEF, bg, bold);
  textn(x + 1, y, s, width - 1, DEF, bg, bold);
}

static void draw_procs(int x, int y, int w, int h) {
  static const char *hdr[4] = {"Command", "CPU %", "Count", "Memory %"};
  draw_box(x, y, w, h, " Process List ");
  int tw = w - 3;
  list_rows = h - 3;
  if (tw < 1 || list_rows < 1) { list_rows = 1; return; }
  int pad = tw > 80 ? 3 : tw > 50 ? 2 : 1;
  int ncol = 4, width[4];
  for (;;) {
    int used = 0;
    for (int i = 1; i < ncol; i++) { width[i] = strlen(hdr[i]) + pad; used += width[i]; }
    width[0] = tw - used;
    if (width[0] >= 12 || ncol == 1) break;
    ncol--;
  }
  int cx = x + 1;
  for (int i = 0; i < ncol; i++) { cell(cx, y + 1, hdr[i], width[i], DEF, 1); cx += width[i]; }

  if (sel < scroll) scroll = sel;
  if (sel >= scroll + list_rows) scroll = sel - list_rows + 1;
  if (scroll < 0) scroll = 0;
  for (int r = 0; r < list_rows && scroll + r < ngroups; r++) {
    Group *g = &groups[scroll + r];
    int yy = y + 2 + r, bg = scroll + r == sel ? PURPLE : DEF;
    if (bg != DEF) for (int i = 0; i < w - 2; i++) put(x + 1 + i, yy, ' ', DEF, bg, 0);
    char v[4][NAME_LEN];
    snprintf(v[0], NAME_LEN, "%s", g->name);
    snprintf(v[1], NAME_LEN, "%.1f", g->cpu);
    snprintf(v[2], NAME_LEN, "%d", g->count);
    snprintf(v[3], NAME_LEN, "%.1f", g->mem);
    cx = x + 1;
    for (int i = 0; i < ncol; i++) { cell(cx, yy, v[i], width[i], bg, 0); cx += width[i]; }
  }
}

static void render(double now) {
  for (int i = 0; i < cols * rows; i++) back[i] = (Cell){' ', DEF, DEF, 0};
  if (cols < 30 || rows < 10) { text(0, 0, "terminal too small", DEF, DEF, 0); return; }

  char buf[160];
  int hx = text(0, 0, " ", PURPLE, DEF, 0);
  hx = text(hx, 0, "fli top", PURPLE, DEF, 1);
  snprintf(buf, sizeof buf, " for %s ", host);
  text(hx, 0, buf, WHITE, DEF, 0);
  time_t t = time(NULL);
  struct tm tm;
  localtime_r(&t, &tm);
  snprintf(buf, sizeof buf, "%02d:%02d:%02d ", tm.tm_hour, tm.tm_min, tm.tm_sec);
  text(cols - 9, 0, buf, DEF, DEF, 0);
  double la[3] = {0};
  if (getloadavg(la, 3) == 3) {
    snprintf(buf, sizeof buf, "Load Average: %.2f %.2f %.2f", la[0], la[1], la[2]);
    text(cols / 2 - 14, 0, buf, DEF, DEF, 0);
  }

  int gh = rows / 2, by = gh + 1, bh = gh - 2, lw = cols / 2;
  draw_chart(0, 1, cols, gh, " CPU Usage ", hist_cpu, cur_cpu);
  draw_chart(0, by, lw, bh, " Memory Usage ", hist_mem, cur_mem);
  draw_procs(lw, by, cols - lw, bh);

  static const char *keys[][2] = {
    {"dd", "Kill process"}, {"j", "Down"}, {"k", "Up"}, {"g", "Jump to top"},
    {"G", "Jump to bottom"}, {"c", "Sort by CPU"}, {"m", "Sort by Mem"},
  };
  int fx = 0, fy = rows - 1;
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
    fx = text(fx, fy, "  ", DEF, DEF, 0);
    fx = text(fx, fy, keys[i][0], BLACK, WHITE, 0);
    fx = text(fx, fy, " ", DEF, DEF, 0);
    fx = text(fx, fy, keys[i][1], DEF, DEF, 0);
  }
  if (now < flash_until) {
    int len = strlen(flash), fx2 = cols - len < fx + 2 ? fx + 2 : cols - len;
    textn(fx2, fy, flash, cols - fx2, DEF, DEF, 1);
  }
}

// ---- input ----

static void handle_keys(const unsigned char *b, int n, double now, int *last_key, double *frozen_until, double *next_scan) {
  for (int i = 0; i < n; i++) {
    int k = b[i];
    if (k == 0x1b) {
      if (i + 1 >= n) { quit_flag = 1; return; }
      if (b[i + 1] != '[' && b[i + 1] != 'O') { i++; continue; }
      int j = i + 2;
      while (j < n && !(b[j] >= 0x40 && b[j] <= 0x7e)) j++;
      if (j >= n) return;
      int first = i + 2 < n ? b[i + 2] : 0;
      switch (b[j]) {
        case 'A': k = 'k'; break;
        case 'B': k = 'j'; break;
        case 'H': k = 'g'; break;
        case 'F': k = 'G'; break;
        case '~': k = first == '5' ? KEY_PGUP : first == '6' ? KEY_PGDN : 0; break;
        default: k = 0;
      }
      i = j;
    }
    switch (k) {
      case 'q': quit_flag = 1; return;
      case 'j': select_row(sel + 1); *frozen_until = now + 1; break;
      case 'k': select_row(sel - 1); *frozen_until = now + 1; break;
      case KEY_PGDN: select_row(sel + list_rows); *frozen_until = now + 1; break;
      case KEY_PGUP: select_row(sel - list_rows); *frozen_until = now + 1; break;
      case 'g': select_row(0); break;
      case 'G': select_row(ngroups - 1); break;
      case 'c':
      case 'm':
        if (sort_mem != (k == 'm')) {
          sort_mem = k == 'm';
          qsort(groups, ngroups, sizeof *groups, cmp_group);
          select_row(0);
        }
        break;
      case 'd':
        if (*last_key == 'd' && ngroups) {
          kill_group(sel_name, now);
          *next_scan = now + 0.5;
          k = 0;
        }
        break;
    }
    *last_key = k;
  }
}

int main(int argc, char **argv) {
  int interval = 300;
  for (int i = 1; i < argc; i++) {
    if ((!strcmp(argv[i], "-i") || !strcmp(argv[i], "--interval")) && i + 1 < argc) interval = atoi(argv[++i]);
    else { fprintf(stderr, "usage: fli top [--interval milliseconds]\n"); return 1; }
  }
  if (interval < 50) interval = 50;
  if (!isatty(0) || !isatty(1)) { fprintf(stderr, "fli top: needs a terminal\n"); return 1; }

  hz = sysconf(_SC_CLK_TCK);
  page_kb = sysconf(_SC_PAGESIZE) / 1024;
  ncpu = sysconf(_SC_NPROCESSORS_ONLN);
  if (ncpu < 1) ncpu = 1;
  gethostname(host, sizeof host - 1);

  struct sigaction sa = {0};
  sa.sa_handler = on_signal;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGWINCH, &sa, NULL);

  tcgetattr(0, &orig_tio);
  struct termios raw = orig_tio;
  raw.c_lflag &= ~(ICANON | ECHO);
  raw.c_iflag &= ~(IXON | ICRNL);
  raw.c_cc[VMIN] = 0;
  raw.c_cc[VTIME] = 0;
  tcsetattr(0, TCSAFLUSH, &raw);
  atexit(term_restore);
  ob("\x1b[?1049h\x1b[?25l", 14);
  resize();

  int window = (1000 + interval - 1) / interval;
  if (window > 31) window = 31;
  double now = mono(), next_tick = now, next_scan = now + 1, frozen_until = 0;
  int last_key = 0;
  sample_cpu(window);
  sample_mem();
  scan_procs(now);
  sort_groups();

  while (!quit_flag) {
    if (resize_flag) { resize_flag = 0; resize(); render(mono()); present(); }
    now = mono();
    if (now >= next_tick) {
      cur_cpu = sample_cpu(window);
      cur_mem = sample_mem();
      hist_cpu[hist_n % HIST] = cur_cpu;
      hist_mem[hist_n % HIST] = cur_mem;
      hist_n++;
      // a pending first 'd' holds the list, so dd kills the row that was shown
      if (now >= next_scan && now >= frozen_until && last_key != 'd') {
        scan_procs(now);
        sort_groups();
        next_scan = now + 2;
      }
      render(now);
      present();
      next_tick += interval / 1000.0;
      if (next_tick < now) next_tick = now + interval / 1000.0;
    }
    int ms = (int)((next_tick - mono()) * 1000) + 1;
    struct pollfd pfd = {0, POLLIN, 0};
    if (poll(&pfd, 1, ms < 0 ? 0 : ms) > 0) {
      unsigned char buf[64];
      int n = read(0, buf, sizeof buf);
      if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) break;
      if (n > 0) {
        now = mono();
        handle_keys(buf, n, now, &last_key, &frozen_until, &next_scan);
        render(now);
        present();
      }
    }
  }
  return 0;
}
