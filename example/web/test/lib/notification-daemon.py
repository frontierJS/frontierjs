# web/test/lib/notification-daemon.py — the desktop's notification daemon, standing in.
#
# A headed Chrome on Linux shows a notification by calling
# org.freedesktop.Notifications.Notify on the session bus, and learns of a click
# from the daemon's ActionInvoked(id, "default") signal. That signal is the only
# way a notification click reaches the browser as a USER's: CDP has no call for
# it, and a script-built NotificationEvent is refused focus() and openWindow().
#
# Run by verify-push.mjs on a private bus of its own, so a real desktop never
# sees the notifications and its daemon never owns the name first.
#
#   stdout  one JSON line per Notify: { id, summary, body, actions }; first { ready: true }
#   stdin   "click <id>" sends ActionInvoked(id, "default"); EOF exits
#
# Needs python3 with dbus-python and PyGObject (Debian: python3-dbus python3-gi).

import sys, json, dbus, dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
IFACE = 'org.freedesktop.Notifications'

class Daemon(dbus.service.Object):
    count = 0

    # Without 'actions' Chrome shows the notification with no default action,
    # and a click on it would reach the browser as nothing.
    @dbus.service.method(IFACE, out_signature='as')
    def GetCapabilities(self): return ['actions', 'body', 'body-hyperlinks', 'persistence']

    @dbus.service.method(IFACE, out_signature='ssss')
    def GetServerInformation(self): return ('fjs-stand-in', 'frontierjs', '1', '1.2')

    @dbus.service.method(IFACE, in_signature='susssasa{sv}i', out_signature='u')
    def Notify(self, app, replaces, icon, summary, body, actions, hints, timeout):
        Daemon.count += 1
        nid = int(replaces) or Daemon.count
        print(json.dumps({'id': nid, 'summary': str(summary), 'body': str(body), 'actions': [str(a) for a in actions]}), flush=True)
        return dbus.UInt32(nid)

    @dbus.service.method(IFACE, in_signature='u')
    def CloseNotification(self, nid): self.NotificationClosed(nid, 3)

    @dbus.service.signal(IFACE, signature='us')
    def ActionInvoked(self, nid, key): pass

    @dbus.service.signal(IFACE, signature='uu')
    def NotificationClosed(self, nid, reason): pass

bus = dbus.SessionBus()
name = dbus.service.BusName(IFACE, bus, do_not_queue=True)
daemon = Daemon(bus, '/org/freedesktop/Notifications')
loop = GLib.MainLoop()

def on_stdin(source, condition):
    line = sys.stdin.readline()
    if not line: loop.quit(); return False
    words = line.split()
    if len(words) == 2 and words[0] == 'click':
        daemon.ActionInvoked(dbus.UInt32(int(words[1])), 'default')
    return True

GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
print(json.dumps({'ready': True}), flush=True)
loop.run()
