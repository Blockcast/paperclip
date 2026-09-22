#!/usr/bin/env python3
"""Add one desired skill to a Paperclip agent's adapterConfig.paperclipSkillSync.

GET -> merge -> PATCH -> GET -> assert, with a provable rollback.

The PATCH sends ONLY the `paperclipSkillSync` key. The server shallow-merges
`adapterConfig` (`{...stored, ...requested}` in `resolveRawEffectiveAdapterConfigForPatch`,
server/src/routes/agents.ts) whenever `replaceAdapterConfig` is not true and the
adapter type is unchanged, so a one-key body stores exactly the same result as
echoing the whole config back -- while keeping `env` off the wire entirely and
shrinking the read-modify-write window to the single key being changed.

Rollback is a first-class mode, not a hand edit: `--rollback` PATCHes the
`paperclipSkillSync` captured in `<agent-id>.before.json` back, re-reads, and
compares. Absent and null are treated as equal for that key, because a shallow
merge cannot delete a key: an agent that had no `paperclipSkillSync` before
reads back as `null` after rollback, which is the same thing to every consumer
(`isinstance(sync, dict)` is false either way). Every other adapterConfig key
must compare byte-identical.

Usage:
  sync-agent-skill.py <agent-id> [--skill NAME] [--dry-run] [--out-dir DIR]
  sync-agent-skill.py <agent-id> --rollback [--out-dir DIR]
`--rollback` and `--dry-run` are mutually exclusive and the script rejects the
pair: rollback always sends a live PATCH, so there is no dry variant of it.

`<agent-id>.before.json` is the ONLY thing `--rollback` can restore from, so
pass an `--out-dir` on durable storage for a real rollout. The `/tmp` default
is pod-local and dies with the pod: losing it between apply and rollback leaves
the change applied with its undo unrecoverable. The script prints a NOTE when a
capture lands somewhere ephemeral.
Env:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY
Exit 0 on "OK:", exit 1 on "FAIL:".
"""
import argparse
import copy
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_SKILL = "paperclipai/paperclip/paperclip-evidence-before-in-review"


def api(method, path, body=None):
    base = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    req = urllib.request.Request(base + path, method=method)
    req.add_header("Authorization", "Bearer " + os.environ["PAPERCLIP_API_KEY"])
    req.add_header("Accept", "application/json")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"error": raw.decode(errors="replace")}


def skill_names(entries):
    """Names the SERVER will honour in desiredSkills.

    Entries are `string | AgentDesiredSkillEntry`. On an object the server reads
    only `key` and drops an object without one (packages/adapter-utils/src/
    server-utils.ts). Accepting `name`/`id` here too would let an entry read as
    present to this script and absent to the server -- so we deliberately match
    the server exactly and surface anything else as unrecognized.
    """
    names, unrecognized = [], []
    for entry in entries or []:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("key"), str):
            names.append(entry["key"])
        else:
            unrecognized.append(entry)
    return names, unrecognized


def sync_block(adapter_config):
    sync = (adapter_config or {}).get("paperclipSkillSync")
    return sync if isinstance(sync, dict) else None


def desired_of(adapter_config):
    sync = sync_block(adapter_config)
    return sync.get("desiredSkills") if isinstance(sync, dict) else None


def merge_sync(adapter_config, skill):
    """Return the new paperclipSkillSync value only -- the whole PATCH body."""
    sync = copy.deepcopy(sync_block(adapter_config) or {})
    desired = sync.get("desiredSkills")
    if not isinstance(desired, list):
        desired = []
    names, _ = skill_names(desired)
    if skill not in names:
        desired = desired + [skill]
    sync["desiredSkills"] = desired
    return sync


def without_sync(adapter_config):
    return {k: v for k, v in (adapter_config or {}).items() if k != "paperclipSkillSync"}


def write(out_dir, name, payload):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
    return path


def get_agent(agent_id, label):
    status, body = api("GET", f"/api/agents/{agent_id}")
    if status != 200:
        print(f"FAIL: GET {label} returned {status}: {body}")
        return None
    return body


def do_rollback(args):
    """PATCH the captured before-state's paperclipSkillSync back and prove it."""
    before_path = os.path.join(args.out_dir, f"{args.agent_id}.before.json")
    if not os.path.exists(before_path):
        print(f"FAIL: no captured before-state at {before_path}; nothing to roll back to")
        return 1
    with open(before_path) as fh:
        before = json.load(fh)
    before_ac = before.get("adapterConfig") or {}

    # A shallow merge cannot delete a key, so restoring "absent" means sending null.
    restore = sync_block(before_ac)
    status, patched = api(
        "PATCH", f"/api/agents/{args.agent_id}", {"adapterConfig": {"paperclipSkillSync": restore}}
    )
    if status != 200:
        print(f"FAIL: rollback PATCH returned {status}: {patched}")
        return 1

    after = get_agent(args.agent_id, "after rollback")
    if after is None:
        return 1
    after_ac = after.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.rolledback.json", after)

    failures = []
    if without_sync(before_ac) != without_sync(after_ac):
        changed = sorted(
            k for k in set(without_sync(before_ac)) | set(without_sync(after_ac))
            if without_sync(before_ac).get(k) != without_sync(after_ac).get(k)
        )
        failures.append(f"non-skill adapterConfig keys changed during rollback: {changed}")

    # Absent and null are the same thing to every consumer of this key.
    if (sync_block(before_ac) or None) != (sync_block(after_ac) or None):
        failures.append(
            f"paperclipSkillSync not restored: {sync_block(before_ac)!r} -> {sync_block(after_ac)!r}"
        )
    if failures:
        print("FAIL: " + " | ".join(failures))
        # The comparison is against the capture, so a legitimate unrelated edit
        # landing between capture and rollback (a model bump, say) lands here
        # too. Fail closed either way and let the operator tell them apart.
        print("Stop the rollout and diff the keys named above against the capture: either this "
              "rollback rewrote something it should not have, or an unrelated edit landed on this "
              "agent since the capture was taken. Do not re-run until you know which.")
        return 1

    print(f"ROLLBACK ROUND-TRIP OK: {after.get('name')} ({args.agent_id}) "
          f"paperclipSkillSync restored to {json.dumps(sync_block(before_ac))}; "
          f"all other adapterConfig keys byte-identical")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_id")
    parser.add_argument("--skill", default=DEFAULT_SKILL)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rollback", action="store_true",
                        help="PATCH the paperclipSkillSync captured in <agent-id>.before.json back")
    parser.add_argument("--out-dir", default="/tmp/track-d")
    args = parser.parse_args()

    # Reject rather than silently ignore: --rollback always sends a live PATCH,
    # so accepting --dry-run beside it would perform the write the operator
    # just asked not to perform. These two flags sit next to each other in the
    # rollout procedure, so the combination is a realistic typo.
    if args.rollback and args.dry_run:
        parser.error("--rollback and --dry-run are mutually exclusive: "
                     "--rollback always sends a live PATCH")

    if args.rollback:
        return do_rollback(args)

    before = get_agent(args.agent_id, "before")
    if before is None:
        return 1
    before_ac = before.get("adapterConfig") or {}
    before_names, unrecognized = skill_names(desired_of(before_ac))
    if unrecognized:
        print(f"FAIL: desiredSkills holds {len(unrecognized)} entr(y/ies) the server will drop "
              f"(an object needs a string `key`): {json.dumps(unrecognized)}")
        return 1
    already = args.skill in before_names

    if args.dry_run:
        # No filesystem writes: a dry run must have no side effects.
        if already:
            print(f"DRY-RUN no PATCH would be sent: {before.get('name')} already has {args.skill}")
        else:
            print(f"DRY-RUN would PATCH {before.get('name')} adapterConfig.paperclipSkillSync ->",
                  json.dumps(merge_sync(before_ac, args.skill)))
        print("DRY-RUN env is not in the PATCH body; stored env keys:",
              sorted((before_ac.get("env") or {}).keys()))
        return 0

    if already:
        print(f"OK: {before.get('name')} already has {args.skill}; no PATCH sent")
        return 0

    # Capture ONLY when a PATCH is about to be sent, and never clobber an earlier
    # capture. Writing unconditionally would let a second run overwrite the
    # pre-change state with a skill-present one, silently turning --rollback into
    # a no-op that still prints ROLLBACK ROUND-TRIP OK.
    before_path = os.path.join(args.out_dir, f"{args.agent_id}.before.json")
    if os.path.exists(before_path):
        print(f"NOTE: keeping the existing pre-change capture at {before_path}")
    else:
        write(args.out_dir, f"{args.agent_id}.before.json", before)
        # This file is the only thing --rollback can restore from. If it is on
        # pod-local storage, a pod loss between apply and rollback leaves the
        # change applied and its undo gone.
        if os.path.realpath(before_path).startswith(("/tmp/", "/var/tmp/")):
            print(f"NOTE: the capture at {before_path} is on ephemeral pod-local storage and is "
                  f"the ONLY rollback source. Copy it somewhere durable (or paste it into the "
                  f"issue) before proceeding to the next agent.")

    status, patched = api(
        "PATCH", f"/api/agents/{args.agent_id}",
        {"adapterConfig": {"paperclipSkillSync": merge_sync(before_ac, args.skill)}},
    )
    if status != 200:
        print(f"FAIL: PATCH returned {status}: {patched}")
        return 1

    after = get_agent(args.agent_id, "after")
    if after is None:
        return 1
    after_ac = after.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.after.json", after)

    failures = []
    after_names, after_unrecognized = skill_names(desired_of(after_ac))
    if args.skill not in after_names:
        failures.append(f"desiredSkills missing {args.skill}: {sync_block(after_ac)!r}")
    if after_unrecognized:
        failures.append(f"server stored entries it will drop: {json.dumps(after_unrecognized)}")
    dropped = [s for s in before_names if s not in after_names]
    if dropped:
        failures.append(f"previously-desired skills dropped: {dropped}")
    before_env = before_ac.get("env") or {}
    after_env = after_ac.get("env") or {}
    if sorted(before_env.keys()) != sorted(after_env.keys()):
        failures.append(f"env keys changed: {sorted(before_env)} -> {sorted(after_env)}")
    if before_env != after_env:
        failures.append("env values differ between before and after GET (both are server-masked; "
                        "a diff means a binding was dropped or rewritten)")
    if without_sync(before_ac) != without_sync(after_ac):
        changed = sorted(
            k for k in set(without_sync(before_ac)) | set(without_sync(after_ac))
            if without_sync(before_ac).get(k) != without_sync(after_ac).get(k)
        )
        failures.append(f"non-skill adapterConfig keys changed: {changed}")
    if failures:
        print("FAIL: " + " | ".join(failures))
        return 1

    print(f"OK: {after.get('name')} ({args.agent_id}) desiredSkills={after_names} "
          f"envKeys={sorted(after_env)} unchanged; adapterType={after.get('adapterType')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
