#!/usr/bin/env python3
"""
Training Monitor - Check on deep-wallwars training progress

Usage:
    python3 check_training.py [--data DIR] [--log FILE] [--models DIR]

Defaults assume running from wallgame repo root.
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ANSI colors
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def parse_args():
    parser = argparse.ArgumentParser(description="Check training progress")
    parser.add_argument(
        "--data",
        default="deep-wallwars/data_12x10_universal",
        help="Path to data directory",
    )
    parser.add_argument(
        "--log",
        default="deep-wallwars/logs/universal_12x10.log",
        help="Path to log file",
    )
    parser.add_argument(
        "--models",
        default="deep-wallwars/models_12x10_universal",
        help="Path to models directory",
    )
    return parser.parse_args()


def check_process_status():
    """Check if training is running and get process info."""
    try:
        result = subprocess.run(
            ["ps", "aux"], capture_output=True, text=True, timeout=5
        )
        lines = result.stdout.strip().split("\n")

        training_proc = None
        deep_ww_proc = None

        for line in lines:
            if "training.py" in line and "grep" not in line:
                training_proc = line
            if "deep_ww" in line and "grep" not in line and "-model1" in line:
                deep_ww_proc = line

        return training_proc, deep_ww_proc
    except Exception as e:
        return None, None


def parse_process_info(proc_line):
    """Extract useful info from ps aux line."""
    if not proc_line:
        return None
    parts = proc_line.split()
    if len(parts) < 11:
        return None
    return {
        "pid": parts[1],
        "cpu": parts[2],
        "mem": parts[3],
        "start": parts[8],
        "time": parts[9],
    }


def get_latest_generation(models_dir):
    """Find the latest model generation."""
    if not os.path.isdir(models_dir):
        return None

    latest = -1
    for f in os.listdir(models_dir):
        if f.startswith("model_") and f.endswith(".pt"):
            try:
                gen = int(f[6:-3])
                latest = max(latest, gen)
            except ValueError:
                pass
    return latest if latest >= 0 else None


def count_games_in_generation(data_dir, generation):
    """Count completed games for a generation."""
    counts = {}
    for variant in ["standard", "classic"]:
        gen_dir = Path(data_dir) / f"generation_{generation}_{variant}"
        if gen_dir.exists():
            csv_files = list(gen_dir.glob("*.csv"))
            counts[variant] = len(csv_files)
        else:
            counts[variant] = 0
    return counts


def get_generation_folders(data_dir):
    """List all generation folders with game counts."""
    if not os.path.isdir(data_dir):
        return []

    generations = {}
    for item in os.listdir(data_dir):
        match = re.match(r"generation_(\d+)_(standard|classic)", item)
        if match:
            gen = int(match.group(1))
            variant = match.group(2)
            gen_path = Path(data_dir) / item
            count = len(list(gen_path.glob("*.csv")))

            if gen not in generations:
                generations[gen] = {}
            generations[gen][variant] = count

    return generations


def parse_log_metrics(log_path, last_n_lines=500):
    """Parse training metrics from log file."""
    if not os.path.isfile(log_path):
        return None

    try:
        # Read last N lines efficiently
        result = subprocess.run(
            ["tail", "-n", str(last_n_lines), log_path],
            capture_output=True,
            text=True,
            timeout=5,
        )
        lines = result.stdout.strip().split("\n")
    except Exception:
        return None

    metrics = {
        "last_training": None,
        "last_selfplay": None,
        "selfplay_times": [],
        "training_results": [],
        "current_phase": "unknown",
    }

    # Patterns
    selfplay_complete = re.compile(r"Completed in (\d+) seconds")
    training_epoch = re.compile(
        r"(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+:\d+)"
    )
    selfplay_start = re.compile(r"Running self play.*generation (\d+)")
    training_start = re.compile(r"Training generation (\d+)")
    games_stat = re.compile(r"W/L/D statistic over (\d+)/(\d+) games")

    for line in lines:
        # Self-play completion
        match = selfplay_complete.search(line)
        if match:
            metrics["selfplay_times"].append(int(match.group(1)))
            metrics["last_selfplay"] = line

        # Training epoch results (FastAI format)
        match = training_epoch.search(line)
        if match:
            metrics["training_results"].append(
                {
                    "epoch": int(match.group(1)),
                    "train_loss": float(match.group(2)),
                    "valid_loss": float(match.group(3)),
                    "val_acc": float(match.group(4)),
                    "move_acc": float(match.group(5)),
                    "time": match.group(6),
                }
            )
            metrics["last_training"] = line
            metrics["current_phase"] = "training"

        # Self-play start
        match = selfplay_start.search(line)
        if match:
            metrics["current_gen"] = int(match.group(1))
            metrics["current_phase"] = "self-play"

        # Training start
        match = training_start.search(line)
        if match:
            metrics["current_gen"] = int(match.group(1))
            metrics["current_phase"] = "training"

        # W/L/D stats
        match = games_stat.search(line)
        if match:
            metrics["last_wld"] = line

    return metrics


def get_log_last_modified(log_path):
    """Get when log was last modified."""
    if not os.path.isfile(log_path):
        return None
    try:
        mtime = os.path.getmtime(log_path)
        return datetime.fromtimestamp(mtime)
    except Exception:
        return None


def get_resource_usage():
    """Get system resource usage."""
    try:
        # Memory
        result = subprocess.run(["free", "-h"], capture_output=True, text=True, timeout=5)
        mem_line = result.stdout.strip().split("\n")[1]
        mem_parts = mem_line.split()
        mem_info = {
            "total": mem_parts[1],
            "used": mem_parts[2],
            "free": mem_parts[3],
        }

        # Load average
        with open("/proc/loadavg", "r") as f:
            load = f.read().split()[:3]

        return {"memory": mem_info, "load": load}
    except Exception:
        return None


def format_duration(seconds):
    """Format seconds as human-readable duration."""
    if seconds < 60:
        return f"{seconds}s"
    elif seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    else:
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        return f"{hours}h {minutes}m"


def print_report(args):
    """Print the training status report."""
    print(f"\n{BOLD}{'=' * 60}{RESET}")
    print(f"{BOLD}  TRAINING STATUS REPORT  {RESET}")
    print(f"{BOLD}{'=' * 60}{RESET}\n")

    # Process status
    print(f"{CYAN}[Process Status]{RESET}")
    training_proc, deep_ww_proc = check_process_status()

    if training_proc:
        info = parse_process_info(training_proc)
        print(f"  {GREEN}training.py is RUNNING{RESET}")
        if info:
            print(f"    PID: {info['pid']}, CPU: {info['cpu']}%, MEM: {info['mem']}%")
            print(f"    Started: {info['start']}, CPU Time: {info['time']}")
    else:
        print(f"  {RED}training.py is NOT RUNNING{RESET}")

    if deep_ww_proc:
        info = parse_process_info(deep_ww_proc)
        print(f"  {GREEN}deep_ww (self-play) is RUNNING{RESET}")
        if info:
            print(f"    PID: {info['pid']}, CPU: {info['cpu']}%, MEM: {info['mem']}%")

            # Extract model info from command
            model_match = re.search(r"model_(\d+)\.trt", deep_ww_proc)
            if model_match:
                print(f"    Using model: generation {model_match.group(1)}")
    else:
        if training_proc:
            print(f"  {YELLOW}deep_ww not running (may be in training/loading phase){RESET}")

    # Log status
    print(f"\n{CYAN}[Log Status]{RESET}")
    log_mtime = get_log_last_modified(args.log)
    if log_mtime:
        age = datetime.now() - log_mtime
        age_str = format_duration(int(age.total_seconds()))
        if age.total_seconds() < 300:  # 5 min
            color = GREEN
        elif age.total_seconds() < 1800:  # 30 min
            color = YELLOW
        else:
            color = RED
        print(f"  Log last updated: {color}{age_str} ago{RESET} ({log_mtime.strftime('%Y-%m-%d %H:%M:%S')})")
    else:
        print(f"  {RED}Log file not found: {args.log}{RESET}")

    # Model generations
    print(f"\n{CYAN}[Model Progress]{RESET}")
    latest_gen = get_latest_generation(args.models)
    if latest_gen is not None:
        print(f"  Latest saved model: {BOLD}generation {latest_gen}{RESET}")
    else:
        print(f"  {RED}No models found in {args.models}{RESET}")

    # Data/games progress
    print(f"\n{CYAN}[Self-Play Data]{RESET}")
    generations = get_generation_folders(args.data)
    if generations:
        # Show last 5 generations
        sorted_gens = sorted(generations.keys(), reverse=True)[:5]
        for gen in sorted(sorted_gens):
            counts = generations[gen]
            std = counts.get("standard", 0)
            cls = counts.get("classic", 0)
            total = std + cls

            if total >= 4000:
                status = f"{GREEN}complete{RESET}"
            elif total > 0:
                status = f"{YELLOW}in progress{RESET}"
            else:
                status = f"{RED}empty{RESET}"

            print(f"  Gen {gen}: standard={std}, classic={cls} ({status})")
    else:
        print(f"  {RED}No data found in {args.data}{RESET}")

    # Metrics from log
    print(f"\n{CYAN}[Training Metrics]{RESET}")
    metrics = parse_log_metrics(args.log)
    if metrics:
        if metrics.get("current_phase"):
            print(f"  Current phase: {BOLD}{metrics['current_phase']}{RESET}")

        if metrics.get("training_results"):
            last = metrics["training_results"][-1]
            print(f"  Last training epoch:")
            print(f"    Loss: {last['train_loss']:.4f} (train), {last['valid_loss']:.4f} (valid)")
            print(f"    Accuracy: {last['val_acc']*100:.1f}% (valuation), {last['move_acc']*100:.1f}% (move)")

        if metrics.get("selfplay_times"):
            times = metrics["selfplay_times"]
            avg_time = sum(times) / len(times)
            print(f"  Self-play times: avg {format_duration(int(avg_time))}, last {format_duration(times[-1])}")

        if metrics.get("last_wld"):
            # Extract W/L/D
            match = re.search(r"(\d+) / (\d+) / (\d+)", metrics["last_wld"])
            if match:
                w, l, d = int(match.group(1)), int(match.group(2)), int(match.group(3))
                total = w + l + d
                print(f"  Last W/L/D: {w}/{l}/{d} ({100*l/total:.0f}% win rate for new model)")
    else:
        print(f"  {YELLOW}Could not parse metrics from log{RESET}")

    # Resource usage
    print(f"\n{CYAN}[System Resources]{RESET}")
    resources = get_resource_usage()
    if resources:
        mem = resources["memory"]
        print(f"  Memory: {mem['used']} / {mem['total']} used")
        print(f"  Load average: {', '.join(resources['load'])}")
    else:
        print(f"  {YELLOW}Could not fetch resource usage{RESET}")

    print(f"\n{BOLD}{'=' * 60}{RESET}\n")


if __name__ == "__main__":
    args = parse_args()
    print_report(args)
