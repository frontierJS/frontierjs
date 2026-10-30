// native/top/src/main.rs — `fli top`, a vtop look-alike in vtop's parallax theme.
//
// Everything is read from /proc, so this is Linux only; commands/utils/top.md
// refuses elsewhere before building. vtop polls by forking `free` every 200 ms
// and `ps` every 2 s (~21% of a core, ~100 MB); this reads the same numbers
// for ~1.3% and ~2 MB, and nearly all of that is the kernel generating
// /proc/<pid>/stat for every process on each 2 s scan.
//
// Layout, column widths and the 256-colour codes copy what blessed renders for
// vtop, so a change here is checked against a vtop screen, not the theme file.
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{read_dir, File};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::time::Instant;

// ─── libc ───────────────────────────────────────────────────────────────────

// Declared here rather than taken from the libc crate: a dependency would make
// the first `fli top` fetch from crates.io. Layouts and numbers are Linux's,
// identical on x86_64 and aarch64.
mod sys {
    use std::os::raw::{c_char, c_int, c_long, c_short, c_uint, c_ulong, c_void};

    pub const TCSAFLUSH: c_int = 2;
    pub const ICANON: c_uint = 0o2;
    pub const ECHO: c_uint = 0o10;
    pub const ICRNL: c_uint = 0o400;
    pub const IXON: c_uint = 0o2000;
    pub const VTIME: usize = 5;
    pub const VMIN: usize = 6;
    pub const TIOCGWINSZ: c_ulong = 0x5413;
    pub const POLLIN: c_short = 1;
    pub const SIGHUP: c_int = 1;
    pub const SIGINT: c_int = 2;
    pub const SIGKILL: c_int = 9;
    pub const SIGTERM: c_int = 15;
    pub const SIGWINCH: c_int = 28;
    pub const SC_CLK_TCK: c_int = 2;
    pub const SC_PAGESIZE: c_int = 30;
    pub const SC_NPROCESSORS_ONLN: c_int = 84;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Termios {
        pub c_iflag: c_uint,
        pub c_oflag: c_uint,
        pub c_cflag: c_uint,
        pub c_lflag: c_uint,
        pub c_line: u8,
        pub c_cc: [u8; 32],
        pub c_ispeed: c_uint,
        pub c_ospeed: c_uint,
    }

    #[repr(C)]
    pub struct Winsize {
        pub ws_row: u16,
        pub ws_col: u16,
        pub ws_xpixel: u16,
        pub ws_ypixel: u16,
    }

    #[repr(C)]
    pub struct PollFd {
        pub fd: c_int,
        pub events: c_short,
        pub revents: c_short,
    }

    #[repr(C)]
    pub struct Tm {
        pub tm_sec: c_int,
        pub tm_min: c_int,
        pub tm_hour: c_int,
        pub tm_mday: c_int,
        pub tm_mon: c_int,
        pub tm_year: c_int,
        pub tm_wday: c_int,
        pub tm_yday: c_int,
        pub tm_isdst: c_int,
        pub tm_gmtoff: c_long,
        pub tm_zone: *const c_char,
    }

    extern "C" {
        pub fn write(fd: c_int, buf: *const c_void, n: usize) -> isize;
        pub fn read(fd: c_int, buf: *mut c_void, n: usize) -> isize;
        pub fn ioctl(fd: c_int, req: c_ulong, ...) -> c_int;
        pub fn kill(pid: c_int, sig: c_int) -> c_int;
        pub fn time(t: *mut i64) -> i64;
        pub fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
        pub fn getloadavg(la: *mut f64, n: c_int) -> c_int;
        pub fn isatty(fd: c_int) -> c_int;
        pub fn gethostname(name: *mut c_char, len: usize) -> c_int;
        // glibc's signal() sets SA_RESTART, which poll() ignores: a resize or a
        // SIGTERM still wakes the main loop.
        pub fn signal(sig: c_int, handler: extern "C" fn(c_int)) -> usize;
        pub fn tcgetattr(fd: c_int, t: *mut Termios) -> c_int;
        pub fn tcsetattr(fd: c_int, act: c_int, t: *const Termios) -> c_int;
        pub fn sysconf(name: c_int) -> c_long;
        pub fn poll(fds: *mut PollFd, n: c_ulong, timeout: c_int) -> c_int;
    }
}

// ─── model ──────────────────────────────────────────────────────────────────

// blessed's 256-colour matches for parallax's #a537fd and #00ebbe: the hex
// values themselves render visibly different from the vtop people know.
const PURPLE: i16 = 135;
const TEAL: i16 = 43;
const WHITE: i16 = 7;
const BLACK: i16 = 0;
const DEF: i16 = -1;

const HIST: usize = 4096;
const KEY_PGUP: i32 = 1001;
const KEY_PGDN: i32 = 1002;
const KEY_ESC: i32 = 1003;

static QUIT: AtomicBool = AtomicBool::new(false);
static RESIZE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq)]
struct Cell {
    ch: char,
    fg: i16,
    bg: i16,
    bold: bool,
}

const BLANK: Cell = Cell {
    ch: ' ',
    fg: DEF,
    bg: DEF,
    bold: false,
};

#[derive(Clone, Copy)]
struct PSamp {
    pid: i32,
    ticks: u64,
    start: u64,
}

struct Proc {
    pid: i32,
    start: u64,
    name: String,
    cpu: f64,
    mem: f64,
    ports: Vec<u16>,
}

struct Group {
    name: String,
    cpu: f64,
    mem: f64,
    count: u32,
    ports: Vec<u16>,
}

// One line of the list: a group, or (pid > 0) one process of the open group.
struct Row {
    name: String,
    pid: i32,
    start: u64,
    label: String,
    cpu: f64,
    mem: f64,
    count: u32,
    ports: String,
}

struct App {
    t0: Instant,
    cols: usize,
    rows: usize,
    back: Vec<Cell>,
    front: Vec<Option<Cell>>,
    out: Vec<u8>,
    hz: f64,
    page_kb: u64,
    ncpu: f64,
    host: String,
    cpu_busy: [u64; 32],
    cpu_total: [u64; 32],
    cpu_n: usize,
    mem_total_kb: u64,
    hist_cpu: Vec<u8>,
    hist_mem: Vec<u8>,
    hist_n: usize,
    cur_cpu: u32,
    cur_mem: u32,
    prev: Vec<PSamp>,
    curr: Vec<PSamp>,
    last_scan: Option<f64>,
    procs: Vec<Proc>,
    port_cache: HashMap<i32, (u64, Vec<u16>)>,
    scans: u32,
    groups: Vec<Group>,
    index: HashMap<String, usize>,
    list: Vec<Row>,
    open: String,
    filter: String,
    typing: bool,
    sort_mem: bool,
    sel: usize,
    sel_name: String,
    sel_pid: i32,
    confirm: bool,
    scroll: usize,
    list_rows: usize,
    flash: String,
    flash_until: f64,
    dots: Vec<u8>,
}

// ─── /proc ──────────────────────────────────────────────────────────────────

fn slurp<'a>(path: &str, buf: &'a mut [u8]) -> Option<&'a [u8]> {
    let n = File::open(path).ok()?.read(buf).ok()?;
    Some(&buf[..n])
}

fn num(t: &[u8]) -> u64 {
    t.iter()
        .skip_while(|b| **b == b' ')
        .take_while(|b| b.is_ascii_digit())
        .fold(0, |a, b| a * 10 + (b - b'0') as u64)
}

fn tokens(s: &[u8]) -> impl Iterator<Item = &[u8]> {
    s.split(|b| *b == b' ').filter(|t| !t.is_empty())
}

// The group name is the comm cut at '/', as vtop does, so kworker/0:1 counts as kworker.
fn read_stat(pid: &str) -> Option<(String, u64, u64, u64)> {
    let mut buf = [0u8; 1024];
    let s = slurp(&format!("/proc/{pid}/stat"), &mut buf)?;
    // comm may hold spaces and parens, so it ends at the LAST ')'
    let l = s.iter().position(|b| *b == b'(')?;
    let r = s.iter().rposition(|b| *b == b')')?;
    if r < l {
        return None;
    }
    let mut name = &s[l + 1..r];
    if let Some(p) = name.iter().position(|b| *b == b'/') {
        name = &name[..p];
    }
    let name = name
        .iter()
        .map(|b| if b.is_ascii() { *b as char } else { '?' })
        .collect();
    // f[i] is stat field i + 3
    let mut f = [0u64; 22];
    for (i, t) in tokens(s.get(r + 2..)?).take(22).enumerate() {
        f[i] = num(t);
    }
    Some((name, f[11] + f[12], f[19], f[21]))
}

fn proc_pids() -> impl Iterator<Item = String> {
    read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.as_bytes()[0].is_ascii_digit())
}

// Socket inode → port for every listening TCP socket, v4 and v6 (state 0A).
fn listen_inodes() -> HashMap<u64, u16> {
    let mut m = HashMap::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(s) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in s.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let port = f[1].rsplit(':').next().and_then(|p| u16::from_str_radix(p, 16).ok());
            if let (Some(port), Ok(ino)) = (port, f[9].parse()) {
                m.insert(ino, port);
            }
        }
    }
    m
}

// Another user's fd directory is unreadable, so a root-owned listener shows no
// port unless fli top runs as root, as with ss -p.
fn pid_ports(pid: &str, listen: &HashMap<u64, u16>) -> Vec<u16> {
    let mut v = Vec::new();
    if listen.is_empty() {
        return v;
    }
    let Ok(dir) = read_dir(format!("/proc/{pid}/fd")) else {
        return v;
    };
    for e in dir.flatten() {
        let Ok(link) = std::fs::read_link(e.path()) else {
            continue;
        };
        if let Some(rest) = link.as_os_str().as_bytes().strip_prefix(b"socket:[") {
            if let Some(p) = listen.get(&num(rest)) {
                if !v.contains(p) {
                    v.push(*p);
                }
            }
        }
    }
    v.sort_unstable();
    v
}

fn fmt_ports(p: &[u16]) -> String {
    p.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ")
}

// argv[0] loses its directory, which would fill the column on its own. A
// kernel thread has an empty cmdline; the caller falls back to its name.
fn read_cmdline(pid: i32) -> String {
    let mut buf = [0u8; 512];
    let s = slurp(&format!("/proc/{pid}/cmdline"), &mut buf).unwrap_or(&[]);
    let arg0 = s.iter().position(|b| *b == 0).unwrap_or(s.len());
    let s = match s[..arg0].iter().rposition(|b| *b == b'/') {
        Some(p) => &s[p + 1..],
        None => s,
    };
    let s: String = s
        .iter()
        .map(|b| match *b {
            0 => ' ',
            0x20..=0x7e => *b as char,
            _ => '?',
        })
        .collect();
    s.trim_end().to_string()
}

fn sig_name(sig: i32) -> &'static str {
    if sig == sys::SIGKILL {
        "SIGKILL"
    } else {
        "SIGTERM"
    }
}

// Every process in the group, as vtop's `killall <name>` does.
fn kill_group(target: &str, sig: i32) -> String {
    let me = std::process::id() as i32;
    let (mut ok, mut denied) = (0, 0);
    for pid_s in proc_pids() {
        match read_stat(&pid_s) {
            Some((name, ..)) if name == target => {}
            _ => continue,
        }
        let pid: i32 = pid_s.parse().unwrap_or(0);
        if pid == me {
            continue;
        }
        if unsafe { sys::kill(pid, sig) } == 0 {
            ok += 1;
        } else {
            denied += 1;
        }
    }
    match (ok, denied) {
        (0, 0) => format!("{target}: no such process "),
        (_, 0) => format!("{target}: {} sent to {ok} ", sig_name(sig)),
        _ => format!("{target}: {ok} killed, {denied} not permitted "),
    }
}

// The start time is read again: a pid reused since the scan is someone else.
fn kill_pid(pid: i32, start: u64, sig: i32) -> String {
    match read_stat(&pid.to_string()) {
        Some((_, _, s, _)) if s == start => {}
        _ => return format!("{pid}: no such process "),
    }
    if unsafe { sys::kill(pid, sig) } == 0 {
        format!("{pid}: {} sent ", sig_name(sig))
    } else {
        format!("{pid}: not permitted ")
    }
}

impl App {
    fn now(&self) -> f64 {
        self.t0.elapsed().as_secs_f64()
    }

    // ─── output ─────────────────────────────────────────────────────────────

    fn sgr_color(&mut self, c: i16, base: i16) {
        if c < 0 {
            return;
        }
        let _ = if c < 8 {
            write!(self.out, ";{}", base + c)
        } else if c < 16 {
            write!(self.out, ";{}", base + 60 + c - 8)
        } else {
            write!(self.out, ";{};5;{}", base + 8, c)
        };
    }

    fn flush_out(&mut self) {
        let mut off = 0;
        while off < self.out.len() {
            let rest = &self.out[off..];
            let n = unsafe { sys::write(1, rest.as_ptr().cast(), rest.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            off += n as usize;
        }
        self.out.clear();
    }

    // Only the cells that changed since the last frame, in one write(): a full
    // repaint every 300 ms is what makes a terminal emulator itself busy.
    fn present(&mut self) {
        let (mut cx, mut cy) = (usize::MAX, usize::MAX);
        let mut style: Option<(i16, i16, bool)> = None;
        for y in 0..self.rows {
            for x in 0..self.cols {
                let b = self.back[y * self.cols + x];
                if self.front[y * self.cols + x] == Some(b) {
                    continue;
                }
                if cx != x || cy != y {
                    let _ = write!(self.out, "\x1b[{};{}H", y + 1, x + 1);
                }
                if style != Some((b.fg, b.bg, b.bold)) {
                    self.out.extend_from_slice(b"\x1b[0");
                    if b.bold {
                        self.out.extend_from_slice(b";1");
                    }
                    self.sgr_color(b.fg, 30);
                    self.sgr_color(b.bg, 40);
                    self.out.push(b'm');
                    style = Some((b.fg, b.bg, b.bold));
                }
                let mut enc = [0u8; 4];
                self.out
                    .extend_from_slice(b.ch.encode_utf8(&mut enc).as_bytes());
                self.front[y * self.cols + x] = Some(b);
                cx = x + 1;
                cy = y;
            }
        }
        self.flush_out();
    }

    fn put(&mut self, x: i32, y: i32, ch: char, fg: i16, bg: i16, bold: bool) {
        if x < 0 || y < 0 || x as usize >= self.cols || y as usize >= self.rows {
            return;
        }
        self.back[y as usize * self.cols + x as usize] = Cell { ch, fg, bg, bold };
    }

    #[allow(clippy::too_many_arguments)]
    fn textn(
        &mut self,
        mut x: i32,
        y: i32,
        s: &str,
        max: i32,
        fg: i16,
        bg: i16,
        bold: bool,
    ) -> i32 {
        for c in s.chars().take(max.max(0) as usize) {
            self.put(x, y, if c.is_ascii() { c } else { '?' }, fg, bg, bold);
            x += 1;
        }
        x
    }

    fn text(&mut self, x: i32, y: i32, s: &str, fg: i16, bg: i16, bold: bool) -> i32 {
        self.textn(x, y, s, i32::MAX, fg, bg, bold)
    }

    fn resize(&mut self) {
        let mut ws = sys::Winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ok = unsafe { sys::ioctl(1, sys::TIOCGWINSZ, &mut ws) } == 0;
        (self.cols, self.rows) = if ok && ws.ws_col > 0 && ws.ws_row > 0 {
            (ws.ws_col as usize, ws.ws_row as usize)
        } else {
            (80, 24)
        };
        self.back = vec![BLANK; self.cols * self.rows];
        self.front = vec![None; self.cols * self.rows];
        self.out.extend_from_slice(b"\x1b[0m\x1b[2J");
    }

    // ─── sensors ────────────────────────────────────────────────────────────

    // CPU % over roughly the last second, like the os-utils cpuUsage vtop uses;
    // one 300 ms tick alone draws a jagged graph that vtop's never is.
    fn sample_cpu(&mut self, window: usize) -> u32 {
        let mut buf = [0u8; 512];
        let Some(s) = slurp("/proc/stat", &mut buf) else {
            return 0;
        };
        let line = s.split(|b| *b == b'\n').next().unwrap_or(&[]);
        let mut v = [0u64; 8];
        for (i, t) in tokens(line).skip(1).take(8).enumerate() {
            v[i] = num(t);
        }
        let total: u64 = v.iter().sum();
        let slot = self.cpu_n % 32;
        self.cpu_busy[slot] = total - v[3] - v[4];
        self.cpu_total[slot] = total;
        self.cpu_n += 1;
        let back = window.min(self.cpu_n - 1);
        if back == 0 {
            return 0;
        }
        let old = (self.cpu_n - 1 - back) % 32;
        let dt = total - self.cpu_total[old];
        let db = self.cpu_busy[slot] - self.cpu_busy[old];
        if dt > 0 {
            (100.0 * db as f64 / dt as f64) as u32
        } else {
            0
        }
    }

    fn sample_mem(&mut self) -> u32 {
        let mut buf = [0u8; 512];
        let Some(s) = slurp("/proc/meminfo", &mut buf) else {
            return 0;
        };
        let mut avail = None;
        for line in s.split(|b| *b == b'\n') {
            if let Some(rest) = line.strip_prefix(b"MemTotal:") {
                self.mem_total_kb = num(rest);
            } else if let Some(rest) = line.strip_prefix(b"MemAvailable:") {
                avail = Some(num(rest));
            }
        }
        match avail {
            Some(a) if self.mem_total_kb > 0 => {
                (100.0 * (self.mem_total_kb - a) as f64 / self.mem_total_kb as f64 + 0.5) as u32
            }
            _ => 0,
        }
    }

    // Per-process CPU is the change since the previous scan. vtop shows ps's
    // average over each process's whole life, so its numbers lag this one's.
    fn scan_procs(&mut self, now: f64) {
        let dt = self.last_scan.map_or(0.0, |t| now - t);
        self.last_scan = Some(now);
        self.curr.clear();
        self.procs.clear();
        self.groups.clear();
        self.index.clear();
        // Reading every fd link costs ~3x the rest of the scan (~26k readlinks
        // on a desktop), so ports are re-walked every 5th scan, ~10 s, and a new
        // listener can take that long to show.
        let fresh = self.scans % 5 == 0;
        self.scans += 1;
        let listen = if fresh {
            self.port_cache.clear();
            listen_inodes()
        } else {
            HashMap::new()
        };
        for pid_s in proc_pids() {
            let Some((name, ticks, start, rss)) = read_stat(&pid_s) else {
                continue;
            };
            let pid: i32 = pid_s.parse().unwrap_or(0);
            let mut cpu = 0.0;
            if dt > 0.0 {
                // a reused pid has a different start time and is a new process
                let used = match self.prev.binary_search_by_key(&pid, |p| p.pid) {
                    Ok(i) if self.prev[i].start == start => {
                        ticks.saturating_sub(self.prev[i].ticks)
                    }
                    _ => ticks,
                };
                cpu = used as f64 / self.hz / dt * 100.0 / self.ncpu;
            }
            let mem = if self.mem_total_kb > 0 {
                (rss * self.page_kb) as f64 * 100.0 / self.mem_total_kb as f64
            } else {
                0.0
            };
            let gi = match self.index.get(&name) {
                Some(&i) => i,
                None => {
                    self.groups.push(Group {
                        name: name.clone(),
                        cpu: 0.0,
                        mem: 0.0,
                        count: 0,
                        ports: Vec::new(),
                    });
                    self.index.insert(name.clone(), self.groups.len() - 1);
                    self.groups.len() - 1
                }
            };
            let g = &mut self.groups[gi];
            g.cpu += cpu;
            g.mem += mem;
            g.count += 1;
            let ports = if fresh {
                let p = pid_ports(&pid_s, &listen);
                self.port_cache.insert(pid, (start, p.clone()));
                p
            } else {
                match self.port_cache.get(&pid) {
                    Some((s, p)) if *s == start => p.clone(),
                    _ => Vec::new(),
                }
            };
            g.ports.extend(&ports);
            self.curr.push(PSamp { pid, ticks, start });
            self.procs.push(Proc {
                pid,
                start,
                name,
                cpu,
                mem,
                ports,
            });
        }
        for g in &mut self.groups {
            g.ports.sort_unstable();
            g.ports.dedup();
        }
        self.curr.sort_unstable_by_key(|p| p.pid);
        std::mem::swap(&mut self.prev, &mut self.curr);
    }

    fn select_row(&mut self, i: isize) {
        self.sel = i.min(self.list.len() as isize - 1).max(0) as usize;
        if let Some(r) = self.list.get(self.sel) {
            self.sel_name.clone_from(&r.name);
            self.sel_pid = r.pid;
        }
    }

    fn find_sel(&mut self) -> bool {
        let at = self
            .list
            .iter()
            .position(|r| r.name == self.sel_name && r.pid == self.sel_pid);
        if let Some(i) = at {
            self.sel = i;
        }
        at.is_some()
    }

    // The groups the filter matches, with the open group's processes under it.
    fn rebuild_rows(&mut self) {
        let m = self.sort_mem;
        let f = self.filter.to_ascii_lowercase();
        self.list.clear();
        for g in &self.groups {
            if !g.name.to_ascii_lowercase().contains(&f) {
                continue;
            }
            self.list.push(Row {
                name: g.name.clone(),
                pid: 0,
                start: 0,
                label: g.name.clone(),
                cpu: g.cpu,
                mem: g.mem,
                count: g.count,
                ports: fmt_ports(&g.ports),
            });
            if g.name != self.open {
                continue;
            }
            let mut kids: Vec<&Proc> = self.procs.iter().filter(|p| p.name == g.name).collect();
            kids.sort_by(|a, b| {
                let (ka, kb) = if m { (a.mem, b.mem) } else { (a.cpu, b.cpu) };
                kb.partial_cmp(&ka)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| a.pid.cmp(&b.pid))
            });
            for p in kids {
                let cmd = read_cmdline(p.pid);
                self.list.push(Row {
                    name: g.name.clone(),
                    pid: p.pid,
                    start: p.start,
                    label: format!("  {} {}", p.pid, if cmd.is_empty() { &p.name } else { &cmd }),
                    cpu: p.cpu,
                    mem: p.mem,
                    count: 0,
                    ports: fmt_ports(&p.ports),
                });
            }
        }
    }

    // At the top the cursor stays put, so the view keeps showing the busiest rows.
    // Once moved it follows its process: a refresh that adds a group above would
    // otherwise slide another process under it, and dd would kill that one. A
    // process that exits hands the cursor to its group.
    fn sort_groups(&mut self) {
        let m = self.sort_mem;
        self.groups.sort_by(|a, b| {
            let (ka, kb) = if m { (a.mem, b.mem) } else { (a.cpu, b.cpu) };
            kb.partial_cmp(&ka)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        self.rebuild_rows();
        if self.sel > 0 {
            if self.find_sel() {
                return;
            }
            self.sel_pid = 0;
            if self.find_sel() {
                return;
            }
        }
        self.select_row(self.sel as isize);
    }

    // One group open at a time; Enter on a process row closes its group.
    fn toggle_open(&mut self) {
        let Some(r) = self.list.get(self.sel) else {
            return;
        };
        let name = r.name.clone();
        self.open = if r.pid == 0 && self.open != name {
            name.clone()
        } else {
            String::new()
        };
        self.sel_name = name;
        self.sel_pid = 0;
        self.rebuild_rows();
        self.find_sel();
    }

    fn refilter(&mut self) {
        self.rebuild_rows();
        self.select_row(0);
    }

    fn target(&self) -> String {
        match self.list.get(self.sel) {
            Some(r) if r.pid > 0 => format!("pid {}", r.pid),
            Some(r) => format!("{} ({})", r.name, r.count),
            None => String::new(),
        }
    }

    // A group row signals the group; a process row only that process.
    fn kill_selected(&mut self, sig: i32, now: f64) {
        let Some(r) = self.list.get(self.sel) else {
            return;
        };
        self.flash = if r.pid > 0 {
            kill_pid(r.pid, r.start, sig)
        } else {
            kill_group(&r.name.clone(), sig)
        };
        self.flash_until = now + 3.0;
    }

    // ─── drawing ────────────────────────────────────────────────────────────

    fn draw_box(&mut self, x: i32, y: i32, w: i32, h: i32, label: &str) {
        if w < 2 || h < 2 {
            return;
        }
        self.put(x, y, '┌', TEAL, DEF, false);
        self.put(x + w - 1, y, '┐', TEAL, DEF, false);
        self.put(x, y + h - 1, '└', TEAL, DEF, false);
        self.put(x + w - 1, y + h - 1, '┘', TEAL, DEF, false);
        for i in 1..w - 1 {
            self.put(x + i, y, '─', TEAL, DEF, false);
            self.put(x + i, y + h - 1, '─', TEAL, DEF, false);
        }
        for j in 1..h - 1 {
            self.put(x, y + j, '│', TEAL, DEF, false);
            self.put(x + w - 1, y + j, '│', TEAL, DEF, false);
        }
        self.textn(x + 2, y, label, w - 3, DEF, DEF, false);
    }

    // vtop's drawille canvas is one cell narrower than the box interior, and its
    // y-scale is (height + 1) / 100; both are copied so the graphs line up.
    fn draw_chart(&mut self, x: i32, y: i32, w: i32, h: i32, label: &str, mem: bool) {
        const BIT: [[u8; 2]; 4] = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
        self.draw_box(x, y, w, h, label);
        let (cw, ch) = (w - 3, h - 2);
        if cw < 1 || ch < 1 {
            return;
        }
        let (cwu, chu) = (cw as usize, ch as usize);
        self.dots.clear();
        self.dots.resize(cwu * chu, 0);
        let (pw, ph) = (cwu * 2, chu * 4);
        let n = self.hist_n.min(pw);
        let hist = if mem { &self.hist_mem } else { &self.hist_cpu };
        for i in 0..n {
            let v = hist[(self.hist_n - n + i) % HIST] as f64;
            let px = pw - n + i;
            let top = (ph as i64 - ((ph + 1) as f64 / 100.0 * v) as i64 - 1).max(0) as usize;
            for py in top..ph {
                self.dots[(py / 4) * cwu + px / 2] |= BIT[py % 4][px % 2];
            }
        }
        for cy in 0..chu {
            for cx in 0..cwu {
                let d = self.dots[cy * cwu + cx];
                let c = if d != 0 {
                    char::from_u32(0x2800 + d as u32).unwrap_or(' ')
                } else {
                    ' '
                };
                self.put(x + 1 + cx as i32, y + 1 + cy as i32, c, PURPLE, DEF, false);
            }
        }
        if cw >= 4 {
            let cur = if mem { self.cur_mem } else { self.cur_cpu };
            self.text(
                x + 1 + cw - 4,
                y + 1,
                &format!("{cur:>3}%"),
                WHITE,
                DEF,
                false,
            );
        }
    }

    // " value" padded and cut to the column width, as vtop's table does.
    fn cell(&mut self, x: i32, y: i32, s: &str, width: i32, bg: i16, bold: bool) {
        if width <= 0 {
            return;
        }
        self.put(x, y, ' ', DEF, bg, bold);
        self.textn(x + 1, y, s, width - 1, DEF, bg, bold);
    }

    fn draw_procs(&mut self, x: i32, y: i32, w: i32, h: i32) {
        const HDR: [&str; 5] = ["Command", "CPU %", "Count", "Memory %", "Ports"];
        let label = if self.typing || !self.filter.is_empty() {
            format!(" Process List /{}{} ", self.filter, if self.typing { "_" } else { "" })
        } else {
            " Process List ".to_string()
        };
        self.draw_box(x, y, w, h, &label);
        let tw = w - 3;
        if tw < 1 || h - 3 < 1 {
            self.list_rows = 1;
            return;
        }
        self.list_rows = (h - 3) as usize;
        let pad = if tw > 80 {
            3
        } else if tw > 50 {
            2
        } else {
            1
        };
        // columns drop from the right until Command keeps 12 cells, as in vtop;
        // Ports is fli's own and goes first
        let mut ncol = 5;
        let mut width = [0i32; 5];
        loop {
            let mut used = 0;
            for i in 1..ncol {
                width[i] = if i == 4 { 12 } else { HDR[i].len() as i32 } + pad;
                used += width[i];
            }
            width[0] = tw - used;
            if width[0] >= 12 || ncol == 1 {
                break;
            }
            ncol -= 1;
        }
        let mut cx = x + 1;
        for i in 0..ncol {
            self.cell(cx, y + 1, HDR[i], width[i], DEF, true);
            cx += width[i];
        }

        if self.sel < self.scroll {
            self.scroll = self.sel;
        }
        if self.sel >= self.scroll + self.list_rows {
            self.scroll = self.sel + 1 - self.list_rows;
        }
        let shown = self
            .list_rows
            .min(self.list.len().saturating_sub(self.scroll));
        for r in 0..shown {
            let g = &self.list[self.scroll + r];
            let v = [
                g.label.clone(),
                format!("{:.1}", g.cpu),
                if g.count > 0 { g.count.to_string() } else { String::new() },
                format!("{:.1}", g.mem),
                g.ports.clone(),
            ];
            let yy = y + 2 + r as i32;
            let bg = if self.scroll + r == self.sel {
                PURPLE
            } else {
                DEF
            };
            if bg != DEF {
                for i in 0..w - 2 {
                    self.put(x + 1 + i, yy, ' ', DEF, bg, false);
                }
            }
            cx = x + 1;
            for i in 0..ncol {
                self.cell(cx, yy, &v[i], width[i], bg, false);
                cx += width[i];
            }
        }
    }

    fn render(&mut self, now: f64) {
        self.back.fill(BLANK);
        let (cols, rows) = (self.cols as i32, self.rows as i32);
        if cols < 30 || rows < 10 {
            self.text(0, 0, "terminal too small", DEF, DEF, false);
            return;
        }

        let hx = self.text(0, 0, " ", PURPLE, DEF, false);
        let hx = self.text(hx, 0, "fli top", PURPLE, DEF, true);
        let host = format!(" for {} ", self.host);
        self.text(hx, 0, &host, WHITE, DEF, false);
        let mut tm: sys::Tm = unsafe { std::mem::zeroed() };
        unsafe { sys::localtime_r(&sys::time(std::ptr::null_mut()), &mut tm) };
        let clock = format!("{:02}:{:02}:{:02} ", tm.tm_hour, tm.tm_min, tm.tm_sec);
        self.text(cols - 9, 0, &clock, DEF, DEF, false);
        let mut la = [0f64; 3];
        if unsafe { sys::getloadavg(la.as_mut_ptr(), 3) } == 3 {
            let s = format!("Load Average: {:.2} {:.2} {:.2}", la[0], la[1], la[2]);
            self.text(cols / 2 - 14, 0, &s, DEF, DEF, false);
        }

        // blessed sizes '50%' as floor(rows / 2) and the lower boxes 2 shorter
        let (gh, lw) = (rows / 2, cols / 2);
        let (by, bh) = (gh + 1, gh - 2);
        self.draw_chart(0, 1, cols, gh, " CPU Usage ", false);
        self.draw_chart(0, by, lw, bh, " Memory Usage ", true);
        self.draw_procs(lw, by, cols - lw, bh);

        const KEYS: [(&str, &str); 10] = [
            ("dd", "Kill process"),
            ("D", "Force kill"),
            ("Enter", "Expand"),
            ("/", "Filter"),
            ("j", "Down"),
            ("k", "Up"),
            ("g", "Jump to top"),
            ("G", "Jump to bottom"),
            ("c", "Sort by CPU"),
            ("m", "Sort by Mem"),
        ];
        let (mut fx, fy) = (0, rows - 1);
        for (k, d) in KEYS {
            fx = self.text(fx, fy, "  ", DEF, DEF, false);
            fx = self.text(fx, fy, k, BLACK, WHITE, false);
            fx = self.text(fx, fy, " ", DEF, DEF, false);
            fx = self.text(fx, fy, d, DEF, DEF, false);
        }
        // over the key list when it runs past the edge: a SIGKILL prompt that
        // drew off-screen would hold the list waiting for an answer nobody sees
        if self.confirm || now < self.flash_until {
            let flash = std::mem::take(&mut self.flash);
            let fx2 = (cols - flash.len() as i32).max(0);
            for x in (fx2 - 1).max(0)..cols {
                self.put(x, fy, ' ', DEF, DEF, false);
            }
            self.textn(fx2, fy, &flash, cols - fx2, DEF, DEF, true);
            self.flash = flash;
        }
    }

    // ─── input ──────────────────────────────────────────────────────────────

    fn handle_keys(
        &mut self,
        b: &[u8],
        now: f64,
        last_key: &mut i32,
        frozen_until: &mut f64,
        next_scan: &mut f64,
    ) {
        let n = b.len();
        let mut i = 0;
        while i < n {
            let mut k = b[i] as i32;
            let mut seq = false;
            // a lone Esc is a key of its own; anything after it is a sequence
            if k == 0x1b && i + 1 >= n {
                k = KEY_ESC;
            } else if k == 0x1b {
                if b[i + 1] != b'[' && b[i + 1] != b'O' {
                    i += 2;
                    continue;
                }
                let mut j = i + 2;
                while j < n && !(0x40..=0x7e).contains(&b[j]) {
                    j += 1;
                }
                if j >= n {
                    return;
                }
                let first = if i + 2 < n { b[i + 2] } else { 0 };
                k = match b[j] {
                    b'A' => 'k' as i32,
                    b'B' => 'j' as i32,
                    b'H' => 'g' as i32,
                    b'F' => 'G' as i32,
                    b'~' if first == b'5' => KEY_PGUP,
                    b'~' if first == b'6' => KEY_PGDN,
                    _ => 0,
                };
                i = j;
                seq = true;
            }
            if self.confirm {
                self.confirm = false;
                if k == 0x79 /* y */ {
                    self.kill_selected(sys::SIGKILL, now);
                    *next_scan = now + 0.5;
                } else {
                    self.flash = "cancelled ".into();
                    self.flash_until = now + 1.5;
                }
                *last_key = 0;
                i += 1;
                continue;
            }
            // while typing a filter, letters are text; arrows still move
            if self.typing && !seq {
                match k {
                    KEY_ESC => {
                        self.typing = false;
                        self.filter.clear();
                    }
                    0x0d | 0x0a => self.typing = false,
                    0x7f | 0x08 => {
                        self.filter.pop();
                    }
                    0x20..=0x7e => self.filter.push(k as u8 as char),
                    _ => {}
                }
                self.refilter();
                i += 1;
                continue;
            }
            let sel = self.sel as isize;
            let page = self.list_rows as isize;
            // moving holds the list for a second, as vtop does, so rows do not
            // reorder under a cursor that is still travelling
            match k {
                // Esc clears a filter first, and quits as in vtop once there is none
                KEY_ESC if !self.filter.is_empty() => {
                    self.filter.clear();
                    self.refilter();
                }
                KEY_ESC | 0x71 /* q */ => {
                    QUIT.store(true, Relaxed);
                    return;
                }
                0x2f /* / */ => self.typing = true,
                0x0d | 0x0a => self.toggle_open(),
                0x44 /* D */ => {
                    if !self.list.is_empty() {
                        self.confirm = true;
                        self.flash = format!("SIGKILL {}? y to confirm ", self.target());
                    }
                }
                0x6a /* j */ => {
                    self.select_row(sel + 1);
                    *frozen_until = now + 1.0;
                }
                0x6b /* k */ => {
                    self.select_row(sel - 1);
                    *frozen_until = now + 1.0;
                }
                KEY_PGDN => {
                    self.select_row(sel + page);
                    *frozen_until = now + 1.0;
                }
                KEY_PGUP => {
                    self.select_row(sel - page);
                    *frozen_until = now + 1.0;
                }
                0x67 /* g */ => self.select_row(0),
                0x47 /* G */ => self.select_row(self.list.len() as isize - 1),
                0x63 | 0x6d /* c m */ => {
                    let want = k == 0x6d;
                    if self.sort_mem != want {
                        self.sort_mem = want;
                        self.sel = 0;
                        self.sort_groups();
                    }
                }
                0x64 /* d */ => {
                    if *last_key == 0x64 && !self.list.is_empty() {
                        self.kill_selected(sys::SIGTERM, now);
                        *next_scan = now + 0.5;
                        k = 0;
                    }
                }
                _ => {}
            }
            *last_key = k;
            i += 1;
        }
    }
}

// ─── terminal ───────────────────────────────────────────────────────────────

extern "C" fn on_signal(s: std::os::raw::c_int) {
    if s == sys::SIGWINCH {
        RESIZE.store(true, Relaxed);
    } else {
        QUIT.store(true, Relaxed);
    }
}

// Restores the shell's terminal on every way out, a panic included; without it
// a crash leaves the user typing blind in raw mode on the alternate screen.
struct Terminal(sys::Termios);

impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe { sys::tcsetattr(0, sys::TCSAFLUSH, &self.0) };
        let _ = std::io::stdout().write_all(b"\x1b[0m\x1b[?25h\x1b[?1049l");
        let _ = std::io::stdout().flush();
    }
}

// One table on stdout and out: CPU needs two scans, so it is the last second's.
fn print_once(app: &mut App) {
    app.sample_cpu(1);
    app.sample_mem();
    app.scan_procs(app.now());
    std::thread::sleep(std::time::Duration::from_secs(1));
    let cpu = app.sample_cpu(1);
    let mem = app.sample_mem();
    app.scan_procs(app.now());
    app.sort_groups();
    let mut la = [0f64; 3];
    unsafe { sys::getloadavg(la.as_mut_ptr(), 3) };
    let w = app.groups.iter().map(|g| g.name.len()).max().unwrap_or(0).max(7);
    let mut o = Vec::with_capacity(16 * 1024);
    let _ = writeln!(
        o,
        "{}  load {:.2} {:.2} {:.2}  cpu {cpu}%  mem {mem}%",
        app.host, la[0], la[1], la[2]
    );
    let _ = writeln!(o, "{:<w$}  {:>6}  {:>5}  {:>8}  Ports", "Command", "CPU %", "Count", "Memory %");
    for g in &app.groups {
        let line = format!(
            "{:<w$}  {:>6.1}  {:>5}  {:>8.1}  {}",
            g.name,
            g.cpu,
            g.count,
            g.mem,
            fmt_ports(&g.ports)
        );
        let _ = writeln!(o, "{}", line.trim_end());
    }
    let _ = std::io::stdout().write_all(&o);
}

fn main() {
    let mut interval: u64 = 300;
    let mut once = false;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        if (args[i] == "-i" || args[i] == "--interval") && i + 1 < args.len() {
            interval = args[i + 1].parse().unwrap_or(300);
            i += 2;
        } else if args[i] == "--once" {
            once = true;
            i += 1;
        } else {
            eprintln!("usage: fli top [--interval milliseconds] [--once]");
            std::process::exit(1);
        }
    }
    let interval = interval.max(50) as f64 / 1000.0;

    let mut hostbuf = [0u8; 64];
    unsafe { sys::gethostname(hostbuf.as_mut_ptr().cast(), hostbuf.len() - 1) };
    let end = hostbuf.iter().position(|b| *b == 0).unwrap_or(0);
    let host = String::from_utf8_lossy(&hostbuf[..end]).into_owned();

    let mut app = App {
        t0: Instant::now(),
        cols: 0,
        rows: 0,
        back: Vec::new(),
        front: Vec::new(),
        out: Vec::with_capacity(64 * 1024),
        hz: unsafe { sys::sysconf(sys::SC_CLK_TCK) } as f64,
        page_kb: unsafe { sys::sysconf(sys::SC_PAGESIZE) } as u64 / 1024,
        ncpu: (unsafe { sys::sysconf(sys::SC_NPROCESSORS_ONLN) } as f64).max(1.0),
        host,
        cpu_busy: [0; 32],
        cpu_total: [0; 32],
        cpu_n: 0,
        mem_total_kb: 0,
        hist_cpu: vec![0; HIST],
        hist_mem: vec![0; HIST],
        hist_n: 0,
        cur_cpu: 0,
        cur_mem: 0,
        prev: Vec::with_capacity(1024),
        curr: Vec::with_capacity(1024),
        last_scan: None,
        procs: Vec::with_capacity(1024),
        port_cache: HashMap::with_capacity(1024),
        scans: 0,
        groups: Vec::with_capacity(256),
        index: HashMap::with_capacity(256),
        list: Vec::with_capacity(256),
        open: String::new(),
        filter: String::new(),
        typing: false,
        sort_mem: false,
        sel: 0,
        sel_name: String::new(),
        sel_pid: 0,
        confirm: false,
        scroll: 0,
        list_rows: 1,
        flash: String::new(),
        flash_until: 0.0,
        dots: Vec::new(),
    };
    if once {
        print_once(&mut app);
        return;
    }
    if unsafe { sys::isatty(0) == 0 || sys::isatty(1) == 0 } {
        eprintln!("fli top: needs a terminal");
        std::process::exit(1);
    }

    for s in [sys::SIGINT, sys::SIGTERM, sys::SIGHUP, sys::SIGWINCH] {
        unsafe { sys::signal(s, on_signal) };
    }

    let mut orig: sys::Termios = unsafe { std::mem::zeroed() };
    unsafe { sys::tcgetattr(0, &mut orig) };
    let mut raw = orig;
    raw.c_lflag &= !(sys::ICANON | sys::ECHO);
    raw.c_iflag &= !(sys::IXON | sys::ICRNL);
    raw.c_cc[sys::VMIN] = 0;
    raw.c_cc[sys::VTIME] = 0;
    unsafe { sys::tcsetattr(0, sys::TCSAFLUSH, &raw) };
    let _term = Terminal(orig);

    app.out.extend_from_slice(b"\x1b[?1049h\x1b[?25l");
    app.resize();
    let window = ((1.0 / interval).ceil() as usize).min(31);
    let mut now = app.now();
    let (mut next_tick, mut next_scan, mut frozen_until) = (now, now + 1.0, 0.0);
    let mut last_key = 0;
    app.sample_cpu(window);
    app.sample_mem();
    app.scan_procs(now);
    app.sort_groups();

    while !QUIT.load(Relaxed) {
        if RESIZE.swap(false, Relaxed) {
            app.resize();
            let t = app.now();
            app.render(t);
            app.present();
        }
        now = app.now();
        if now >= next_tick {
            app.cur_cpu = app.sample_cpu(window);
            app.cur_mem = app.sample_mem();
            app.hist_cpu[app.hist_n % HIST] = app.cur_cpu as u8;
            app.hist_mem[app.hist_n % HIST] = app.cur_mem as u8;
            app.hist_n += 1;
            // a pending first 'd' or SIGKILL prompt holds the list, so the row shown is the one signalled
            if now >= next_scan && now >= frozen_until && last_key != 0x64 && !app.confirm {
                app.scan_procs(now);
                app.sort_groups();
                next_scan = now + 2.0;
            }
            app.render(now);
            app.present();
            next_tick += interval;
            if next_tick < now {
                next_tick = now + interval;
            }
        }
        let ms = ((next_tick - app.now()) * 1000.0) as i32 + 1;
        let mut pfd = sys::PollFd {
            fd: 0,
            events: sys::POLLIN,
            revents: 0,
        };
        if unsafe { sys::poll(&mut pfd, 1, ms.max(0)) } > 0 {
            let mut buf = [0u8; 64];
            let n = unsafe { sys::read(0, buf.as_mut_ptr().cast(), buf.len()) };
            if n == 0 {
                break;
            }
            if n < 0 {
                let k = std::io::Error::last_os_error().kind();
                if k == std::io::ErrorKind::Interrupted || k == std::io::ErrorKind::WouldBlock {
                    continue;
                }
                break;
            }
            now = app.now();
            app.handle_keys(
                &buf[..n as usize],
                now,
                &mut last_key,
                &mut frozen_until,
                &mut next_scan,
            );
            app.render(now);
            app.present();
        }
    }
}
