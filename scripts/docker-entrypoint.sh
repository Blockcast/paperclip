#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# /paperclip is a PVC in agent Jobs, so image-layer links below it are hidden.
# Replace any ad hoc browser cached there with the image-pinned headless shell.
# A read-only or unexpectedly shaped PVC must not prevent the requested command
# from starting, especially under an arbitrary non-root UID.
install_browser_link() {
    browser=${CHROME_BIN:-/usr/local/bin/google-chrome}
    browser_bin=${PAPERCLIP_HOME:-/paperclip}/bin
    browser_link=$browser_bin/google-chrome
    [ -x "$browser" ] || return 0

    if [ -L "$browser_bin" ] || { [ -e "$browser_bin" ] && [ ! -d "$browser_bin" ]; }; then
        echo "docker-entrypoint.sh: refusing unsafe browser link destination $browser_bin" >&2
        return 0
    fi
    if ! mkdir -p "$browser_bin" 2>/dev/null; then
        echo "docker-entrypoint.sh: $browser_bin is not writable; browser link not installed" >&2
        return 0
    fi
    if ! ln -sfn "$browser" "$browser_link" 2>/dev/null; then
        echo "docker-entrypoint.sh: could not install browser link in $browser_bin" >&2
    fi
}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    install_browser_link
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Ensure ~/.local/bin/claude exists for the chat plugin which hard-codes
# `${HOME}/.local/bin/claude` (see @lucitra/paperclip-plugin-chat). The
# image bakes this symlink, but /paperclip is a PVC mount in k8s, so
# anything under /paperclip in the image layer is hidden at runtime.
mkdir -p /paperclip/.local/bin
if [ ! -e /paperclip/.local/bin/claude ]; then
    ln -sf /usr/local/bin/claude /paperclip/.local/bin/claude
fi
chown -R node:node /paperclip/.local 2>/dev/null || true
install_browser_link

exec gosu node "$@"
