// The image pins the source tree and Python environment used by the gateway.
export const hermesCronBootstrap = String.raw`import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, "/opt/hermes")
from cron import jobs

JOB_ID = hashlib.sha256(b"spawnfile-agent-schedule").hexdigest()[:12]
OWNER = "spawnfile.agent-schedule.v1"


def read_descriptor(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def reconcile(descriptor):
    fingerprint = hashlib.sha256(json.dumps(descriptor, sort_keys=True).encode()).hexdigest()
    with jobs._fire_job_lock(JOB_ID) as acquired:
        if not acquired:
            raise RuntimeError("Could not acquire Hermes schedule ownership lock")
        with jobs._jobs_lock():
            all_jobs = jobs.load_jobs()
            current = next((job for job in all_jobs if job.get("id") == JOB_ID), None)
            if current and current.get("spawnfile_owner") != OWNER:
                raise RuntimeError("Native Hermes cron ID collides with the Spawnfile job")
            if current and current.get("spawnfile_descriptor") == fingerprint:
                return
            retained = [job for job in all_jobs if job.get("id") != JOB_ID]
            if descriptor is None:
                if current:
                    jobs.save_jobs(retained, removed_ids={JOB_ID})
                return

            trigger = descriptor["trigger"]
            schedule = jobs.parse_schedule(trigger["schedule"])
            zone = trigger.get("timezone")
            jobs.validate_schedule_knobs(schedule, zone, None)
            next_run = jobs.compute_next_run(schedule, timezone=zone)
            if next_run is None:
                raise RuntimeError("Hermes could not compute the next Spawnfile schedule run")
            from cron.lifecycle_guard import check_gateway_lifecycle
            payload = dict(descriptor["job"], workdir=str(Path(__file__).resolve().parent.parent / "workspace"))
            check_gateway_lifecycle(payload["prompt"], None)
            retained.append({
                **payload,
                "id": JOB_ID,
                "name": "Spawnfile agent schedule",
                "spawnfile_owner": OWNER,
                "spawnfile_descriptor": fingerprint,
                "schedule": schedule,
                "schedule_display": schedule["display"],
                "repeat": {"times": None, "completed": 0},
                "enabled": True,
                "state": "scheduled",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "next_run_at": next_run,
                **({"timezone": zone} if zone else {}),
            })
            jobs.save_jobs(retained)


def main():
    descriptor = read_descriptor(Path(sys.argv[1])) if SCHEDULE_ENABLED else None
    reconcile(descriptor)
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    main()
`;
