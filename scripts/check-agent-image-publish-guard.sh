#!/bin/sh
# PEN-4932 stage 3b-i. Asserts that the PEN-3156 pre-push publish guard actually
# reached a built agent image, in the shape the agent will meet it.
#
# Run INSIDE the image under test, fed over stdin, so one body serves both the
# assertion step and its positive control:
#
#   docker run --rm -i --entrypoint sh IMAGE -eus -- runtime   < this file
#   docker run --rm -i --entrypoint sh IMAGE -eus -- ownership < this file
#
# The two modes exist because they must run as different uids and neither can
# answer the other's question:
#
#   runtime    uid 1000, the uid git spawns the hook as. Asks only what that uid
#              can actually do. A root `test -x` is true of a 0700 file uid 1000
#              can neither read nor run, which is exactly the delivery defect
#              this is here to catch, so the useful arm MUST NOT run as root.
#   ownership  uid 0. Asks what uid 1000 must NOT be able to do — rewrite the
#              guard (PEN-3715). uid 1000 cannot assert that about itself.
#
# `#!/bin/sh` is also why `-r` matters as much as `-x` below: the launcher is a
# shell script, so the kernel hands it to an interpreter that has to READ it.
set -eu

hooks=/usr/local/libexec/paperclip/hooks
mode="${1:?usage: $0 runtime|ownership}"

case "$mode" in
  runtime)
    test -d "$hooks" ||
      { echo "PEN-4932: $hooks is missing from the agent image" >&2; exit 1; }
    test -x "$hooks" ||
      { echo "PEN-4932: $hooks is not traversable by uid 1000" >&2; exit 1; }
    # Checked separately from the loop: an empty directory satisfies every
    # per-file assertion below vacuously, and empty is precisely the shape a
    # mistyped --exclude glob or a COPY of the wrong stage produces. The
    # consumer does not degrade on it — runGitEgressRuntime REFUSES a publish
    # when it finds no executable pre-push where it looks, so an empty
    # directory stops every push in the fleet once stage 3b-ii repoints the
    # runtime at this path.
    test -f "$hooks/pre-push" ||
      { echo "PEN-4932: $hooks/pre-push did not reach the agent image" >&2; exit 1; }
    for entry in "$hooks"/*; do
      test -r "$entry" ||
        { echo "PEN-4932: $entry is not readable by uid 1000" >&2; exit 1; }
      test -x "$entry" ||
        { echo "PEN-4932: $entry is not executable by uid 1000" >&2; exit 1; }
    done
    echo "PEN-4932: publish guard is readable and executable by uid 1000"
    ;;
  ownership)
    # `offender=$(find ...)` rather than `test -z "$(find ...)"`: a simple
    # assignment adopts the substituted command's exit status, so a find that
    # breaks fails the step instead of yielding "" that `test -z` reads as a
    # pass. -print -quit stops at the first offender; its path is the message.
    offender="$(find "$hooks" \( ! -user root -o -perm /022 \) -print -quit)"
    test -z "$offender" ||
      { echo "PEN-4932: delivered publish guard is agent-writable or not root-owned: $offender" >&2; exit 1; }
    echo "PEN-4932: publish guard is root-owned and not agent-writable"
    ;;
  *)
    echo "usage: $0 runtime|ownership" >&2
    exit 2
    ;;
esac
