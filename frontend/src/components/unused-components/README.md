# Unused Components

This folder contains UI components that are not currently imported or used anywhere in the codebase. They have been moved here to keep the main `ui/` folder clean while preserving them for future use.

## How to Re-Add a Component

### Step 1: Move the Component File

Move the component file from `unused-components/` back to `components/ui/`:

```bash
# Example: Re-adding the Accordion component
mv frontend/src/components/unused-components/accordion.tsx frontend/src/components/ui/
```

### Step 2: Install Required Dependencies

Each component requires specific dependencies. Install them using your package manager:

```bash
# Using bun (recommended)
cd frontend
bun add <dependency-name>

# Or using npm
cd frontend
npm install <dependency-name>
```

### Step 3: Import and Use

Import the component in your route or component file:

```tsx
import { ComponentName } from "@/components/ui/component-name";
```

## Component Reference

Below is a list of all unused components and their required dependencies:
