#!/usr/bin/env python3
"""Add one desired skill to a Paperclip agent's adapterConfig.paperclipSkillSync.

GET -> merge -> PATCH -> GET -> assert. Only paperclipSkillSync changes.
The server restores redacted ("***") env bindings from the stored config on
PATCH, so the full adapterConfig from GET is sent back unchanged apart from
paperclipSkillSync. Before/after JSON is written to --out-dir as evidence.

Usage:
  add-desired-skill.py <agent-id> [--skill NAME] [--dry-run] [--out-dir DIR]
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
    """desiredSkills holds strings or AgentDesiredSkillEntry objects."""
    names = []
    for entry in entries or []:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict):
            for key in ("skill", "name", "key", "id"):
                if isinstance(entry.get(key), str):
                    names.append(entry[key])
                    break
    return names


def current_skills(adapter_config):
    """Skill names already on an adapterConfig, tolerating a missing/odd sync block."""
    sync = (adapter_config or {}).get("paperclipSkillSync")
    if not isinstance(sync, dict):
        return []
    return skill_names(sync.get("desiredSkills"))


def merge(adapter_config, skill):
    merged = copy.deepcopy(adapter_config or {})
    sync = merged.get("paperclipSkillSync")
    if not isinstance(sync, dict):
        sync = {}
    desired = sync.get("desiredSkills")
    if not isinstance(desired, list):
        desired = []
    if skill not in skill_names(desired):
        desired = desired + [skill]
    merged["paperclipSkillSync"] = {**sync, "desiredSkills": desired}
    return merged


def without_sync(adapter_config):
    return {k: v for k, v in (adapter_config or {}).items() if k != "paperclipSkillSync"}


def write(out_dir, name, payload):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("agent_id")
    parser.add_argument("--skill", default=DEFAULT_SKILL)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out-dir", default="/tmp/track-d")
    args = parser.parse_args()

    status, before = api("GET", f"/api/agents/{args.agent_id}")
    if status != 200:
        print(f"FAIL: GET before returned {status}: {before}")
        return 1
    before_ac = before.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.before.json", before)
    merged = merge(before_ac, args.skill)

    if args.dry_run:
        print("DRY-RUN paperclipSkillSync ->", json.dumps(merged["paperclipSkillSync"]))
        print("DRY-RUN env keys unchanged:", sorted((before_ac.get("env") or {}).keys()))
        return 0

    if args.skill in current_skills(before_ac):
        print(f"OK: {before.get('name')} already has {args.skill}; no PATCH sent")
        return 0

    status, patched = api("PATCH", f"/api/agents/{args.agent_id}", {"adapterConfig": merged})
    if status != 200:
        print(f"FAIL: PATCH returned {status}: {patched}")
        return 1

    status, after = api("GET", f"/api/agents/{args.agent_id}")
    if status != 200:
        print(f"FAIL: GET after returned {status}: {after}")
        return 1
    after_ac = after.get("adapterConfig") or {}
    write(args.out_dir, f"{args.agent_id}.after.json", after)

    failures = []
    after_sync = after_ac.get("paperclipSkillSync")
    if not isinstance(after_sync, dict) or args.skill not in skill_names(after_sync.get("desiredSkills")):
        failures.append(f"desiredSkills missing {args.skill}: {after_sync}")
    before_env = before_ac.get("env") or {}
    after_env = after_ac.get("env") or {}
    if sorted(before_env.keys()) != sorted(after_env.keys()):
        failures.append(f"env keys changed: {sorted(before_env)} -> {sorted(after_env)}")
    if before_env != after_env:
        failures.append(
            "env values differ between before and after GET (both are server-masked; "
            "a diff means a binding was dropped or rewritten)"
        )
    if without_sync(before_ac) != without_sync(after_ac):
        changed = sorted(
            k for k in set(without_sync(before_ac)) | set(without_sync(after_ac))
            if without_sync(before_ac).get(k) != without_sync(after_ac).get(k)
        )
        failures.append(f"non-skill adapterConfig keys changed: {changed}")
    # The merge is additive: every previously-desired skill must survive the PATCH.
    dropped = sorted(set(current_skills(before_ac)) - set(skill_names(after_sync.get("desiredSkills"))
                                                          if isinstance(after_sync, dict) else []))
    if dropped:
        failures.append(f"previously-desired skills dropped: {dropped}")
    if failures:
        print("FAIL: " + " | ".join(failures))
        return 1

    print(f"OK: {after.get('name')} ({args.agent_id}) desiredSkills={skill_names(after_sync['desiredSkills'])} "
          f"envKeys={sorted(after_env)} unchanged; adapterType={after.get('adapterType')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
