import torch
model = torch.load("models_8x8_standard/model_37.pt", map_location='cpu')

state = model.state_dict()
weights = state["priors.4.weight"]
biases = state["priors.4.bias"]

wall_p = 128
cat_p = range(128, 132)
mouse_p = range(132, 136)

print(f"Wall biases (mean): {biases[wall_p].mean().item():.4f}")
print(f"Cat biases (mean):  {biases[cat_p].mean().item():.4f}")
print(f"Mouse biases (mean): {biases[mouse_p].mean().item():.4f}")
print(f"Cat weights (abs mean):   {weights[cat_p].abs().mean().item():.6f}")
print(f"Mouse weights (abs mean): {weights[mouse_p].abs().mean().item():.6f}")
print(f"Cat weights (max):        {weights[cat_p].max().item():.6f}")
print(f"Mouse weights (max):      {weights[mouse_p].max().item():.6f}")

print(model.priors)
