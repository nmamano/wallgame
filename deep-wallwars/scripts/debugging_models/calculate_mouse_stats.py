import os
import glob

data_dir = "deep-wallwars/data_8x8_standard"
generations = []

# Get all generation directories
if not os.path.exists(data_dir):
    print(f"Error: Directory {data_dir} not found.")
    exit(1)

for d in os.listdir(data_dir):
    if d.startswith("generation_"):
        try:
            gen_num = int(d.split("_")[1])
            generations.append(gen_num)
        except:
            continue

generations.sort()

print("Generation,MouseMovePercentage")

for gen in generations:
    gen_path = os.path.join(data_dir, f"generation_{gen}")
    files = glob.glob(os.path.join(gen_path, "game_*.csv"))[:50] # Sample 50 files
    
    total_mouse = 0
    total_turns = 0
    
    for f_path in files:
        try:
            with open(f_path, 'r') as f:
                lines = f.readlines()
                # Every 4th line is a prior line, starting from line 2 (index 1)
                for i in range(1, len(lines), 4):
                    total_turns += 1
                    # Parse priors
                    priors = [float(x) for x in lines[i].strip().split(', ')]
                    if len(priors) < 136: continue
                    
                    # Find max prior index
                    max_val = -1
                    max_idx = -1
                    for idx, val in enumerate(priors):
                        if val > max_val:
                            max_val = val
                            max_idx = idx
                    
                    # 132-135 are mouse moves (0-based)
                    if 132 <= max_idx <= 135:
                        total_mouse += 1
        except Exception as e:
            continue
            
    if total_turns > 0:
        percentage = (total_mouse / total_turns) * 100
        print(f"{gen},{percentage:.4f}")
    else:
        print(f"{gen},0.0000")
