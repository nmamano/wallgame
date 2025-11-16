# Guide: Re-Adding Unused Components

This guide provides step-by-step instructions for re-adding any component from the `unused-components` folder.

## General Process

1. **Move the component file** from `unused-components/` to `ui/`
2. **Install required dependencies** (see `COMPONENT_DEPENDENCIES.md`)
3. **Update imports** in your code
4. **Test the component**

## Detailed Steps

### Example: Re-adding Accordion Component

#### Step 1: Move the File
```bash
# From project root
cd frontend/src/components
mv unused-components/accordion.tsx ui/
```

#### Step 2: Install Dependencies
```bash
# From project root
cd frontend
bun add @radix-ui/react-accordion@1.2.2
```

#### Step 3: Update Your Code
In `routes/learn.tsx`, replace the manual accordion implementation:

**Before:**
```tsx
const [openSections, setOpenSections] = useState<Record<string, boolean>>({
  rules: true,
  notation: false,
  // ...
});

const toggleSection = (section: string) => {
  setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
};

// Manual implementation with Card and buttons
```

**After:**
```tsx
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// Use Accordion component
<Accordion type="single" collapsible defaultValue="rules">
  <AccordionItem value="rules">
    <AccordionTrigger>Rules (Standard)</AccordionTrigger>
    <AccordionContent>
      {/* Content here */}
    </AccordionContent>
  </AccordionItem>
  {/* More items... */}
</Accordion>
```

#### Step 4: Verify
- Check that the component renders correctly
- Test keyboard navigation
- Verify accessibility features work

## Common Patterns

### Form Components
If re-adding `form.tsx`, you'll typically also want:
- `checkbox.tsx` or `radio-group.tsx` for form inputs
- `@hookform/resolvers` + `zod` for validation

### Date/Time Components
If re-adding `calendar.tsx`, you'll need:
- `date-fns` for date utilities
- Consider `react-day-picker` updates if version changes

### Chart Components
If re-adding `chart.tsx`:
- Check `recharts` version compatibility
- May need to update chart configuration syntax

## Troubleshooting

### Import Errors
If you see import errors after moving a component:
1. Check that the dependency is installed: `bun install`
2. Verify the import path: `@/components/ui/component-name`
3. Check TypeScript types are available

### Styling Issues
If styles look wrong:
1. Ensure `tailwindcss-animate` is installed (already in dependencies)
2. Check that component uses `cn()` utility for className merging
3. Verify theme variables are set correctly

### Missing Dependencies
If a component needs additional dependencies:
1. Check `COMPONENT_DEPENDENCIES.md` for full list
2. Some components depend on others (e.g., `toggle-group` needs `toggle`)
3. Check component file imports for clues

## Notes

- All components follow the same pattern and use `@/lib/utils` for `cn()`
- Components use Radix UI primitives for accessibility
- Styling is consistent with the existing design system
- Components are already configured with proper TypeScript types

