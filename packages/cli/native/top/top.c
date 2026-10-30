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
#define KEY_ESC 1003
#define PROC_PORTS 16
#define GROUP_PORTS 32

typedef struct { uint32_t ch; int16_t fg, bg; uint8_t bold; } Cell;
typedef struct {
  int pid, nports;
  unsigned long long ticks, start;
  char name[NAME_LEN];
  double cpu, mem;
  uint16_t ports[PROC_PORTS];
} PSamp;
typedef struct { char name[NAME_LEN]; double cpu, mem; int count, nports; uint16_t ports[GROUP_PORTS]; } Group;
// One line of the list: a group, or (pid > 0) one process of the open group.
typedef struct {
  char name[NAME_LEN], label[160], ports[96];
  int pid, count;
  unsigned long long start;
  double cpu, mem;
} Row;
typedef struct { unsigned long long ino; uint16_t port; } Listen;

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
static int scans;
static Group *groups;
static int ngroups, cap_groups, sort_mem;
static Row *list;
static int nlist, cap_list;
static char open_name[NAME_LEN], filter[32];
static int typing, confirm;
static int sel, sel_pid, scroll, list_rows = 1;
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

static int cmp_port(const void *a, const void *b) {
  return *(const uint16_t *)a - *(const uint16_t *)b;
}

// Socket inode -> port for every listening TCP socket, v4 and v6 (state 0A).
static Listen *listen_tab;
static int nlisten, cap_listen;

static void read_listen(void) {
  nlisten = 0;
  const char *paths[] = {"/proc/net/tcp", "/proc/net/tcp6"};
  char line[512];
  for (int f = 0; f < 2; f++) {
    FILE *fp = fopen(paths[f], "re");
    if (!fp) continue;
    if (!fgets(line, sizeof line, fp)) { fclose(fp); continue; }
    while (fgets(line, sizeof line, fp)) {
      char local[64], st[8];
      unsigned long long ino;
      // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
      if (sscanf(line, "%*s %63s %*s %7s %*s %*s %*s %*s %*s %llu", local, st, &ino) != 3) continue;
      if (strcmp(st, "0A")) continue;
      char *c = strrchr(local, ':');
      if (!c) continue;
      if (nlisten == cap_listen) { cap_listen = cap_listen ? cap_listen * 2 : 64; listen_tab = realloc(listen_tab, sizeof *listen_tab * cap_listen); }
      listen_tab[nlisten++] = (Listen){ino, (uint16_t)strtoul(c + 1, NULL, 16)};
    }
    fclose(fp);
  }
}

// Another user's fd directory is unreadable, so a root-owned listener shows no
// port unless fli top runs as root, as with ss -p.
static void pid_ports(int pid, PSamp *p) {
  p->nports = 0;
  if (!nlisten) return;
  char path[64], link[64];
  snprintf(path, sizeof path, "/proc/%d/fd", pid);
  DIR *d = opendir(path);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    ssize_t n = readlinkat(dirfd(d), e->d_name, link, sizeof link - 1);
    if (n < 9 || strncmp(link, "socket:[", 8)) continue;
    link[n] = 0;
    unsigned long long ino = strtoull(link + 8, NULL, 10);
    for (int i = 0; i < nlisten; i++) {
      if (listen_tab[i].ino != ino) continue;
      int seen = 0;
      for (int j = 0; j < p->nports; j++) seen |= p->ports[j] == listen_tab[i].port;
      if (!seen && p->nports < PROC_PORTS) p->ports[p->nports++] = listen_tab[i].port;
      break;
    }
  }
  closedir(d);
  qsort(p->ports, p->nports, sizeof *p->ports, cmp_port);
}

static void fmt_ports(char *out, int cap, const uint16_t *ports, int n) {
  int len = 0;
  out[0] = 0;
  for (int i = 0; i < n && len < cap; i++) len += snprintf(out + len, cap - len, i ? " %u" : "%u", ports[i]);
}

// argv[0] loses its directory, which would fill the column on its own. A
// kernel thread has an empty cmdline; the caller falls back to its name.
static void read_cmdline(int pid, char *out, int cap) {
  char path[64], buf[512];
  snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
  int n = slurp(path, buf, sizeof buf);
  out[0] = 0;
  if (n <= 0) return;
  char *s = buf, *slash = strrchr(buf, '/');
  if (slash) s = slash + 1;
  int len = 0;
  for (char *c = s; c < buf + n && len < cap - 1; c++) out[len++] = !*c ? ' ' : (unsigned char)*c >= 0x20 && (unsigned char)*c < 0x7f ? *c : '?';
  while (len && out[len - 1] == ' ') len--;
  out[len] = 0;
}

// Per-process CPU is the change since the previous scan. Reading every fd link
// costs ~3x the rest of the scan (~26k readlinks on a desktop), so ports are
// re-walked every 5th scan, ~10 s, and a new listener can take that long to show.
static void scan_procs(double now) {
  DIR *d = opendir("/proc");
  if (!d) return;
  double dt = last_scan > 0 ? now - last_scan : 0;
  last_scan = now;
  int fresh = scans++ % 5 == 0;
  if (fresh) read_listen();
  ncurr = 0;
  ngroups = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!isdigit((unsigned char)e->d_name[0])) continue;
    if (ncurr == cap_curr) { cap_curr = cap_curr ? cap_curr * 2 : 1024; curr = realloc(curr, sizeof *curr * cap_curr); }
    PSamp *s = &curr[ncurr];
    unsigned long long rss;
    if (read_stat(e->d_name, s->name, &s->ticks, &s->start, &rss)) continue;
    s->pid = atoi(e->d_name);
    // a reused pid has a different start time and is a new process
    PSamp key = {.pid = s->pid};
    PSamp *p = nprev ? bsearch(&key, prev, nprev, sizeof *prev, cmp_pid) : NULL;
    if (p && p->start != s->start) p = NULL;
    s->cpu = dt > 0 ? (p ? s->ticks - p->ticks : s->ticks) / (double)hz / dt * 100.0 / ncpu : 0;
    s->mem = mem_total_kb ? rss * page_kb * 100.0 / mem_total_kb : 0;
    if (fresh) pid_ports(s->pid, s);
    else if (p) { s->nports = p->nports; memcpy(s->ports, p->ports, sizeof s->ports); }
    else s->nports = 0;
    ncurr++;

    Group *g = NULL;
    for (int i = 0; i < ngroups; i++) if (!strcmp(groups[i].name, s->name)) { g = &groups[i]; break; }
    if (!g) {
      if (ngroups == cap_groups) { cap_groups = cap_groups ? cap_groups * 2 : 256; groups = realloc(groups, sizeof *groups * cap_groups); }
      g = &groups[ngroups++];
      memcpy(g->name, s->name, NAME_LEN);
      g->cpu = g->mem = 0;
      g->count = g->nports = 0;
    }
    g->cpu += s->cpu;
    g->mem += s->mem;
    g->count++;
    for (int i = 0; i < s->nports; i++) {
      int seen = 0;
      for (int j = 0; j < g->nports; j++) seen |= g->ports[j] == s->ports[i];
      if (!seen && g->nports < GROUP_PORTS) g->ports[g->nports++] = s->ports[i];
    }
  }
  closedir(d);
  for (int i = 0; i < ngroups; i++) qsort(groups[i].ports, groups[i].nports, sizeof *groups[i].ports, cmp_port);
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

static int cmp_kid(const void *a, const void *b) {
  const PSamp *x = *(PSamp *const *)a, *y = *(PSamp *const *)b;
  double kx = sort_mem ? x->mem : x->cpu, ky = sort_mem ? y->mem : y->cpu;
  if (kx != ky) return kx < ky ? 1 : -1;
  return x->pid - y->pid;
}

static Row *push_row(void) {
  if (nlist == cap_list) { cap_list = cap_list ? cap_list * 2 : 256; list = realloc(list, sizeof *list * cap_list); }
  return &list[nlist++];
}

// The groups the filter matches, with the open group's processes under it.
static void rebuild_rows(void) {
  static PSamp **kids;
  static int cap_kids;
  nlist = 0;
  for (int i = 0; i < ngroups; i++) {
    Group *g = &groups[i];
    if (!strcasestr(g->name, filter)) continue;
    Row *r = push_row();
    memcpy(r->name, g->name, NAME_LEN);
    snprintf(r->label, sizeof r->label, "%s", g->name);
    r->pid = 0; r->start = 0; r->cpu = g->cpu; r->mem = g->mem; r->count = g->count;
    fmt_ports(r->ports, sizeof r->ports, g->ports, g->nports);
    if (strcmp(g->name, open_name)) continue;
    int nk = 0;
    for (int j = 0; j < nprev; j++) {
      if (strcmp(prev[j].name, g->name)) continue;
      if (nk == cap_kids) { cap_kids = cap_kids ? cap_kids * 2 : 64; kids = realloc(kids, sizeof *kids * cap_kids); }
      kids[nk++] = &prev[j];
    }
    qsort(kids, nk, sizeof *kids, cmp_kid);
    for (int j = 0; j < nk; j++) {
      PSamp *p = kids[j];
      char cmd[140];
      read_cmdline(p->pid, cmd, sizeof cmd);
      r = push_row();
      memcpy(r->name, g->name, NAME_LEN);
      snprintf(r->label, sizeof r->label, "  %d %s", p->pid, cmd[0] ? cmd : p->name);
      r->pid = p->pid; r->start = p->start; r->cpu = p->cpu; r->mem = p->mem; r->count = 0;
      fmt_ports(r->ports, sizeof r->ports, p->ports, p->nports);
    }
  }
}

static void select_row(int i) {
  if (i >= nlist) i = nlist - 1;
  if (i < 0) i = 0;
  sel = i;
  if (nlist) { memcpy(sel_name, list[i].name, NAME_LEN); sel_pid = list[i].pid; }
}

static int find_sel(void) {
  for (int i = 0; i < nlist; i++) {
    if (list[i].pid == sel_pid && !strcmp(list[i].name, sel_name)) { sel = i; return 1; }
  }
  return 0;
}

// At the top the cursor stays put, so the view keeps showing the busiest rows.
// Once moved it follows its process: a refresh that adds a group above would
// otherwise slide another process under it, and dd would kill that one. A
// process that exits hands the cursor to its group.
static void sort_groups(void) {
  qsort(groups, ngroups, sizeof *groups, cmp_group);
  rebuild_rows();
  if (sel > 0) {
    if (find_sel()) return;
    sel_pid = 0;
    if (find_sel()) return;
  }
  select_row(sel);
}

// One group open at a time; Enter on a process row closes its group.
static void toggle_open(void) {
  if (!nlist) return;
  Row *r = &list[sel];
  char name[NAME_LEN];
  memcpy(name, r->name, NAME_LEN);
  if (!r->pid && strcmp(open_name, name)) memcpy(open_name, name, NAME_LEN);
  else open_name[0] = 0;
  memcpy(sel_name, name, NAME_LEN);
  sel_pid = 0;
  rebuild_rows();
  find_sel();
}

static void refilter(void) {
  rebuild_rows();
  select_row(0);
}

static const char *sig_name(int sig) { return sig == SIGKILL ? "SIGKILL" : "SIGTERM"; }

// Every process in the group, as vtop's `killall <name>` does.
static void kill_group(const char *target, int sig) {
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
    if (kill(pid, sig) == 0) ok++;
    else denied++;
  }
  closedir(d);
  if (!ok && !denied) snprintf(flash, sizeof flash, "%s: no such process ", target);
  else if (denied) snprintf(flash, sizeof flash, "%s: %d killed, %d not permitted ", target, ok, denied);
  else snprintf(flash, sizeof flash, "%s: %s sent to %d ", target, sig_name(sig), ok);
}

// The start time is read again: a pid reused since the scan is someone else.
static void kill_pid(int pid, unsigned long long start, int sig) {
  char pid_s[16], name[NAME_LEN];
  unsigned long long a, s, c;
  snprintf(pid_s, sizeof pid_s, "%d", pid);
  if (read_stat(pid_s, name, &a, &s, &c) || s != start) snprintf(flash, sizeof flash, "%d: no such process ", pid);
  else if (kill(pid, sig) == 0) snprintf(flash, sizeof flash, "%d: %s sent ", pid, sig_name(sig));
  else snprintf(flash, sizeof flash, "%d: not permitted ", pid);
}

// A group row signals the group; a process row only that process.
static void kill_selected(int sig, double now) {
  if (!nlist) return;
  Row *r = &list[sel];
  if (r->pid) kill_pid(r->pid, r->start, sig);
  else kill_group(r->name, sig);
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
  static const char *hdr[5] = {"Command", "CPU %", "Count", "Memory %", "Ports"};
  char label[64] = " Process List ";
  if (typing || filter[0]) snprintf(label, sizeof label, " Process List /%s%s ", filter, typing ? "_" : "");
  draw_box(x, y, w, h, label);
  int tw = w - 3;
  list_rows = h - 3;
  if (tw < 1 || list_rows < 1) { list_rows = 1; return; }
  int pad = tw > 80 ? 3 : tw > 50 ? 2 : 1;
  // columns drop from the right until Command keeps 12 cells, as in vtop;
  // Ports is fli's own and goes first
  int ncol = 5, width[5];
  for (;;) {
    int used = 0;
    for (int i = 1; i < ncol; i++) { width[i] = (i == 4 ? 12 : (int)strlen(hdr[i])) + pad; used += width[i]; }
    width[0] = tw - used;
    if (width[0] >= 12 || ncol == 1) break;
    ncol--;
  }
  int cx = x + 1;
  for (int i = 0; i < ncol; i++) { cell(cx, y + 1, hdr[i], width[i], DEF, 1); cx += width[i]; }

  if (sel < scroll) scroll = sel;
  if (sel >= scroll + list_rows) scroll = sel - list_rows + 1;
  if (scroll < 0) scroll = 0;
  for (int r = 0; r < list_rows && scroll + r < nlist; r++) {
    Row *g = &list[scroll + r];
    int yy = y + 2 + r, bg = scroll + r == sel ? PURPLE : DEF;
    if (bg != DEF) for (int i = 0; i < w - 2; i++) put(x + 1 + i, yy, ' ', DEF, bg, 0);
    char v[3][NAME_LEN];
    snprintf(v[0], NAME_LEN, "%.1f", g->cpu);
    snprintf(v[1], NAME_LEN, g->count ? "%d" : "", g->count);
    snprintf(v[2], NAME_LEN, "%.1f", g->mem);
    const char *vals[5] = {g->label, v[0], v[1], v[2], g->ports};
    cx = x + 1;
    for (int i = 0; i < ncol; i++) { cell(cx, yy, vals[i], width[i], bg, 0); cx += width[i]; }
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
    {"dd", "Kill process"}, {"D", "Force kill"}, {"Enter", "Expand"}, {"/", "Filter"}, {"j", "Down"}, {"k", "Up"}, {"g", "Jump to top"},
    {"G", "Jump to bottom"}, {"c", "Sort by CPU"}, {"m", "Sort by Mem"},
  };
  int fx = 0, fy = rows - 1;
  for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
    fx = text(fx, fy, "  ", DEF, DEF, 0);
    fx = text(fx, fy, keys[i][0], BLACK, WHITE, 0);
    fx = text(fx, fy, " ", DEF, DEF, 0);
    fx = text(fx, fy, keys[i][1], DEF, DEF, 0);
  }
  // over the key list when it runs past the edge: a SIGKILL prompt that
  // drew off-screen would hold the list waiting for an answer nobody sees
  if (confirm || now < flash_until) {
    int len = strlen(flash), fx2 = cols - len < 0 ? 0 : cols - len;
    for (int x = fx2 > 0 ? fx2 - 1 : 0; x < cols; x++) put(x, fy, ' ', DEF, DEF, 0);
    textn(fx2, fy, flash, cols - fx2, DEF, DEF, 1);
  }
}

// ---- input ----

static void handle_keys(const unsigned char *b, int n, double now, int *last_key, double *frozen_until, double *next_scan) {
  for (int i = 0; i < n; i++) {
    int k = b[i], seq = 0;
    // a lone Esc is a key of its own; anything after it is a sequence
    if (k == 0x1b && i + 1 >= n) k = KEY_ESC;
    else if (k == 0x1b) {
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
      seq = 1;
    }
    if (confirm) {
      confirm = 0;
      if (k == 'y') { kill_selected(SIGKILL, now); *next_scan = now + 0.5; }
      else { snprintf(flash, sizeof flash, "cancelled "); flash_until = now + 1.5; }
      *last_key = 0;
      continue;
    }
    // while typing a filter, letters are text; arrows still move
    if (typing && !seq) {
      size_t len = strlen(filter);
      if (k == KEY_ESC) { typing = 0; filter[0] = 0; }
      else if (k == '\r' || k == '\n') typing = 0;
      else if (k == 0x7f || k == 0x08) { if (len) filter[len - 1] = 0; }
      else if (k >= 0x20 && k < 0x7f && len < sizeof filter - 1) { filter[len] = k; filter[len + 1] = 0; }
      refilter();
      continue;
    }
    switch (k) {
      // Esc clears a filter first, and quits as in vtop once there is none
      case KEY_ESC:
        if (filter[0]) { filter[0] = 0; refilter(); break; }
        quit_flag = 1; return;
      case 'q': quit_flag = 1; return;
      case '/': typing = 1; break;
      case '\r':
      case '\n': toggle_open(); break;
      case 'D':
        if (nlist) {
          confirm = 1;
          Row *r = &list[sel];
          if (r->pid) snprintf(flash, sizeof flash, "SIGKILL pid %d? y to confirm ", r->pid);
          else snprintf(flash, sizeof flash, "SIGKILL %s (%d)? y to confirm ", r->name, r->count);
        }
        break;
      case 'j': select_row(sel + 1); *frozen_until = now + 1; break;
      case 'k': select_row(sel - 1); *frozen_until = now + 1; break;
      case KEY_PGDN: select_row(sel + list_rows); *frozen_until = now + 1; break;
      case KEY_PGUP: select_row(sel - list_rows); *frozen_until = now + 1; break;
      case 'g': select_row(0); break;
      case 'G': select_row(nlist - 1); break;
      case 'c':
      case 'm':
        if (sort_mem != (k == 'm')) {
          sort_mem = k == 'm';
          sel = 0;
          sort_groups();
        }
        break;
      case 'd':
        if (*last_key == 'd' && nlist) {
          kill_selected(SIGTERM, now);
          *next_scan = now + 0.5;
          k = 0;
        }
        break;
    }
    *last_key = k;
  }
}

// One table on stdout and out: CPU needs two scans, so it is the last second's.
static void print_once(void) {
  sample_cpu(1);
  sample_mem();
  scan_procs(mono());
  sleep(1);
  int cpu = sample_cpu(1), mem = sample_mem();
  scan_procs(mono());
  sort_groups();
  double la[3] = {0};
  getloadavg(la, 3);
  int w = 7;
  for (int i = 0; i < ngroups; i++) if ((int)strlen(groups[i].name) > w) w = strlen(groups[i].name);
  printf("%s  load %.2f %.2f %.2f  cpu %d%%  mem %d%%\n", host, la[0], la[1], la[2], cpu, mem);
  printf("%-*s  %6s  %5s  %8s  Ports\n", w, "Command", "CPU %", "Count", "Memory %");
  for (int i = 0; i < ngroups; i++) {
    Group *g = &groups[i];
    char ports[200];
    fmt_ports(ports, sizeof ports, g->ports, g->nports);
    printf("%-*s  %6.1f  %5d  %8.1f%s%s\n", w, g->name, g->cpu, g->count, g->mem, ports[0] ? "  " : "", ports);
  }
}

int main(int argc, char **argv) {
  int interval = 300, once = 0;
  for (int i = 1; i < argc; i++) {
    if ((!strcmp(argv[i], "-i") || !strcmp(argv[i], "--interval")) && i + 1 < argc) interval = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--once")) once = 1;
    else { fprintf(stderr, "usage: fli top [--interval milliseconds] [--once]\n"); return 1; }
  }
  if (interval < 50) interval = 50;

  hz = sysconf(_SC_CLK_TCK);
  page_kb = sysconf(_SC_PAGESIZE) / 1024;
  ncpu = sysconf(_SC_NPROCESSORS_ONLN);
  if (ncpu < 1) ncpu = 1;
  gethostname(host, sizeof host - 1);
  if (once) { print_once(); return 0; }
  if (!isatty(0) || !isatty(1)) { fprintf(stderr, "fli top: needs a terminal\n"); return 1; }

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
      // a pending first 'd' or SIGKILL prompt holds the list, so the row shown is the one signalled
      if (now >= next_scan && now >= frozen_until && last_key != 'd' && !confirm) {
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
