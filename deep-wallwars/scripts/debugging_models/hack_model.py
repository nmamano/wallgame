import torch
import torch.onnx
import os
from model import ResNet # Ensure model.py is in your PYTHONPATH or same directory

# CONFIGURATION
MODEL_PATH = "models_8x8_standard/model_37.pt" 
OUTPUT_PT_PATH = "model_mouse_test.pt"
OUTPUT_ONNX_PATH = "model_mouse_test.onnx"
COLUMNS = 8
ROWS = 8
INPUT_CHANNELS = 8
INFERENCE_BATCH_SIZE = 1 # We only need batch size 1 for testing

def hack():
    print(f"Loading {MODEL_PATH}...")
    # Load the model
    model = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    state = model.state_dict()

    # Indices for Standard 8x8:
    # 0 to 127: Walls
    # 128-131: Cat Moves
    # 132-135: Mouse Moves
    
    wall_prior_size = 2 * COLUMNS * ROWS # 128
    mouse_start = wall_prior_size + 4    # 132
    mouse_end = wall_prior_size + 8      # 136

    print("Jacking up Mouse Move weights...")
    # Set bias for mouse moves to 10.0 (extremely high probability after softmax)
    state["priors.4.bias"][mouse_start:mouse_end] = 10.0
    
    # Optionally zero out Cat move biases to ensure the Mouse is preferred
    state["priors.4.bias"][wall_prior_size:mouse_start] = -10.0 

    model.load_state_dict(state)
    
    # Save PyTorch model
    print(f"Saving hacked model to {OUTPUT_PT_PATH}...")
    torch.save(model, OUTPUT_PT_PATH)

    # Export to ONNX
    print(f"Exporting ONNX model to {OUTPUT_ONNX_PATH}...")
    input_names = ["States"]
    output_names = ["Priors", "Values"]
    dummy_input = torch.randn(
        INFERENCE_BATCH_SIZE, INPUT_CHANNELS, COLUMNS, ROWS
    )
    
    # Disable log_output if your ResNet class uses it (matching training.py logic)
    if hasattr(model, 'log_output'):
        model.log_output = False
        
    torch.onnx.export(
        model,
        dummy_input,
        OUTPUT_ONNX_PATH,
        input_names=input_names,
        output_names=output_names,
        opset_version=11 # Standard opset
    )
    
    print("Done!")

if __name__ == "__main__":
    hack()
