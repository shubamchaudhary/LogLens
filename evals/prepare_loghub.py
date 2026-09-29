#!/usr/bin/env python3
"""Prepare Loghub 2k samples for the window-level anomaly eval.

LogLens's chunker recognises ISO-8601 and syslog timestamps only. Most Loghub
systems use other formats, so this adapter PREFIXES every line with an ISO
timestamp taken from the dataset's own time field (line order and count are
preserved). That isolates what we want to test (the anomaly rules) from
timestamp-format coverage, which is reported separately by WindowEvalCli
(`timestampRecognizedLines` on the raw file).

Labels: BGL and Thunderbird mark each line with '-' (normal) or an alert
category in the first field. Other 2k samples carry no anomaly labels and are
used only for gating / false-alarm counts.

Source: https://github.com/logpai/loghub (Loghub, ISSRE 2023). See LICENSE_loghub.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.join(os.path.dirname(__file__), "datasets", "loghub")


def ts_bgl(line: str):
    # "- 1117838570 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.50.675872 ..."
    parts = line.split()
    return datetime.fromtimestamp(int(parts[1]), timezone.utc)


def ts_thunderbird(line: str):
    return datetime.fromtimestamp(int(line.split()[1]), timezone.utc)


def ts_hdfs(line: str):
    p = line.split()
    return datetime.strptime(p[0] + p[1], "%y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def ts_spark(line: str):
    p = line.split()
    return datetime.strptime(p[0] + " " + p[1], "%y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc)


def ts_apache(line: str):
    m = re.match(r"\[(\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4})\]", line)
    return datetime.strptime(m.group(1), "%a %b %d %H:%M:%S %Y").replace(tzinfo=timezone.utc)


ADAPTERS = {"BGL": ts_bgl, "Thunderbird": ts_thunderbird, "HDFS": ts_hdfs,
            "Spark": ts_spark, "Apache": ts_apache}
LABELLED = {"BGL", "Thunderbird"}


def main() -> None:
    out_dir = os.path.join(HERE, "prepared")
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in ADAPTERS.items():
        src = os.path.join(HERE, f"{name}_2k.log")
        lines = open(src, encoding="utf-8", errors="replace").read().splitlines()
        out, labels, last = [], {}, None
        for i, line in enumerate(lines, 1):
            try:
                t = fn(line)
                last = t
            except Exception:
                t = last  # continuation line: inherit
            stamp = t.strftime("%Y-%m-%d %H:%M:%S") if t else "1970-01-01 00:00:00"
            out.append(f"{stamp} {line}")
            if name in LABELLED:
                labels[i] = line.split(" ", 1)[0] != "-"
        with open(os.path.join(out_dir, f"{name}_2k.iso.log"), "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        if labels:
            with open(os.path.join(out_dir, f"{name}_2k.labels.json"), "w") as f:
                json.dump({"alert_lines": [i for i, a in labels.items() if a], "lines": len(lines)}, f)
        print(name, len(lines), "alerts" if labels else "", sum(labels.values()) if labels else "")


if __name__ == "__main__":
    sys.exit(main())
