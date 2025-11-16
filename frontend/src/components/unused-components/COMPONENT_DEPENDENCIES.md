# Component Dependencies Reference

This document lists all unused components and the exact dependencies needed to re-add them.

## Radix UI Components

### Accordion
- **File**: `accordion.tsx`
- **Dependency**: `@radix-ui/react-accordion@1.2.2`
- **Install**: `bun add @radix-ui/react-accordion@1.2.2`
- **Note**: Should be used in `routes/learn.tsx` to replace manual accordion implementation

### Alert Dialog
- **File**: `alert-dialog.tsx`
- **Dependency**: `@radix-ui/react-alert-dialog@1.1.4`
- **Install**: `bun add @radix-ui/react-alert-dialog@1.1.4`
- **Usage**: For confirmation dialogs (delete confirmations, etc.)

### Aspect Ratio
- **File**: `aspect-ratio.tsx`
- **Dependency**: `@radix-ui/react-aspect-ratio@1.1.1`
- **Install**: `bun add @radix-ui/react-aspect-ratio@1.1.1`
- **Usage**: Maintain aspect ratios for images/videos

### Avatar
- **File**: `avatar.tsx`
- **Dependency**: `@radix-ui/react-avatar@1.1.2`
- **Install**: `bun add @radix-ui/react-avatar@1.1.2`
- **Usage**: User profile pictures/avatars

### Checkbox
- **File**: `checkbox.tsx`
- **Dependency**: `@radix-ui/react-checkbox@1.1.3`
- **Install**: `bun add @radix-ui/react-checkbox@1.1.3`
- **Usage**: Checkbox inputs for forms

### Collapsible
- **File**: `collapsible.tsx`
- **Dependency**: `@radix-ui/react-collapsible@1.1.2`
- **Install**: `bun add @radix-ui/react-collapsible@1.1.2`
- **Usage**: Expandable/collapsible content sections

### Context Menu
- **File**: `context-menu.tsx`
- **Dependency**: `@radix-ui/react-context-menu@2.2.4`
- **Install**: `bun add @radix-ui/react-context-menu@2.2.4`
- **Usage**: Right-click context menus

### Drawer
- **File**: `drawer.tsx`
- **Dependency**: `vaul@^0.9.9`
- **Install**: `bun add vaul@^0.9.9`
- **Usage**: Mobile-friendly slide-out drawers

### Hover Card
- **File**: `hover-card.tsx`
- **Dependency**: `@radix-ui/react-hover-card@1.1.4`
- **Install**: `bun add @radix-ui/react-hover-card@1.1.4`
- **Usage**: Cards that appear on hover

### Input OTP
- **File**: `input-otp.tsx`
- **Dependency**: `input-otp@1.4.1`
- **Install**: `bun add input-otp@1.4.1`
- **Usage**: OTP/verification code inputs

### Menubar
- **File**: `menubar.tsx`
- **Dependency**: `@radix-ui/react-menubar@1.1.4`
- **Install**: `bun add @radix-ui/react-menubar@1.1.4`
- **Usage**: Desktop-style menu bars

### Navigation Menu
- **File**: `navigation-menu.tsx`
- **Dependency**: `@radix-ui/react-navigation-menu@1.2.3`
- **Install**: `bun add @radix-ui/react-navigation-menu@1.2.3`
- **Usage**: Complex navigation menus with dropdowns

### Popover
- **File**: `popover.tsx`
- **Dependency**: `@radix-ui/react-popover@1.1.4`
- **Install**: `bun add @radix-ui/react-popover@1.1.4`
- **Usage**: Popover tooltips/dropdowns

### Progress
- **File**: `progress.tsx`
- **Dependency**: `@radix-ui/react-progress@1.1.1`
- **Install**: `bun add @radix-ui/react-progress@1.1.1`
- **Usage**: Progress bars/indicators

### Radio Group
- **File**: `radio-group.tsx`
- **Dependency**: `@radix-ui/react-radio-group@1.2.2`
- **Install**: `bun add @radix-ui/react-radio-group@1.2.2`
- **Usage**: Radio button groups for forms

### Scroll Area
- **File**: `scroll-area.tsx`
- **Dependency**: `@radix-ui/react-scroll-area@1.2.2`
- **Install**: `bun add @radix-ui/react-scroll-area@1.2.2`
- **Usage**: Custom scrollable areas

### Slider
- **File**: `slider.tsx`
- **Dependency**: `@radix-ui/react-slider@1.2.2`
- **Install**: `bun add @radix-ui/react-slider@1.2.2`
- **Usage**: Range sliders for inputs

### Tabs
- **File**: `tabs.tsx`
- **Dependency**: `@radix-ui/react-tabs@1.1.2`
- **Install**: `bun add @radix-ui/react-tabs@1.1.2`
- **Usage**: Tabbed interfaces

### Toggle
- **File**: `toggle.tsx`
- **Dependency**: `@radix-ui/react-toggle@1.1.1`
- **Install**: `bun add @radix-ui/react-toggle@1.1.1`
- **Usage**: Toggle buttons

### Toggle Group
- **File**: `toggle-group.tsx`
- **Dependency**: `@radix-ui/react-toggle-group@1.1.1`
- **Install**: `bun add @radix-ui/react-toggle-group@1.1.1`
- **Note**: Also requires `toggle.tsx` (moves together)
- **Usage**: Groups of toggle buttons

## Third-Party Components

### Calendar
- **File**: `calendar.tsx`
- **Dependency**: `react-day-picker@9.8.0`
- **Install**: `bun add react-day-picker@9.8.0`
- **Usage**: Date picker/calendar component

### Carousel
- **File**: `carousel.tsx`
- **Dependency**: `embla-carousel-react@8.5.1`
- **Install**: `bun add embla-carousel-react@8.5.1`
- **Usage**: Image/content carousels

### Chart
- **File**: `chart.tsx`
- **Dependency**: `recharts@2.15.4`
- **Install**: `bun add recharts@2.15.4`
- **Usage**: Data visualization charts

### Form
- **File**: `form.tsx`
- **Dependency**: `react-hook-form@^7.60.0`
- **Install**: `bun add react-hook-form@^7.60.0`
- **Optional**: `@hookform/resolvers@^3.10.0` (for Zod validation)
- **Usage**: Form handling with validation

### Sonner (Toast Alternative)
- **File**: `sonner.tsx`
- **Dependency**: `sonner@^1.7.4`
- **Install**: `bun add sonner@^1.7.4`
- **Note**: Alternative to Radix Toast. You already have `toast.tsx` using Radix.
- **Usage**: Toast notifications (alternative implementation)

### Resizable Panels
- **File**: `resizable.tsx`
- **Dependency**: `react-resizable-panels@^2.1.7`
- **Install**: `bun add react-resizable-panels@^2.1.7`
- **Usage**: Resizable split panels (like VS Code)

## Additional Dependencies

### Date Utilities
- **Dependency**: `date-fns@4.1.0`
- **Install**: `bun add date-fns@4.1.0`
- **Usage**: Date formatting/manipulation (used with Calendar)

### Form Validation
- **Dependency**: `@hookform/resolvers@^3.10.0`
- **Install**: `bun add @hookform/resolvers@^3.10.0`
- **Note**: Only needed if using Zod with react-hook-form
- **Usage**: Connects Zod schemas to react-hook-form

### Zod (Backend Only)
- **Note**: Zod is already installed in root `package.json` for backend use
- **Frontend**: Only needed if using for form validation with `@hookform/resolvers`
- **Install**: `bun add zod@3.25.76` (if needed in frontend)

## Quick Re-Add Commands

### Re-add Accordion (for Learn page)
```bash
cd frontend
mv src/components/unused-components/accordion.tsx src/components/ui/
bun add @radix-ui/react-accordion@1.2.2
```

### Re-add Form Components
```bash
cd frontend
mv src/components/unused-components/form.tsx src/components/ui/
bun add react-hook-form@^7.60.0
# Optional: bun add @hookform/resolvers@^3.10.0 zod@3.25.76
```

### Re-add Calendar/Date Picker
```bash
cd frontend
mv src/components/unused-components/calendar.tsx src/components/ui/
bun add react-day-picker@9.8.0 date-fns@4.1.0
```

### Re-add Chart Components
```bash
cd frontend
mv src/components/unused-components/chart.tsx src/components/ui/
bun add recharts@2.15.4
```

### Re-add All Radix UI Components (if needed)
```bash
cd frontend
mv src/components/unused-components/{accordion,alert-dialog,aspect-ratio,avatar,checkbox,collapsible,context-menu,drawer,hover-card,menubar,navigation-menu,popover,progress,radio-group,scroll-area,slider,tabs,toggle,toggle-group}.tsx src/components/ui/
bun add @radix-ui/react-accordion@1.2.2 @radix-ui/react-alert-dialog@1.1.4 @radix-ui/react-aspect-ratio@1.1.1 @radix-ui/react-avatar@1.1.2 @radix-ui/react-checkbox@1.1.3 @radix-ui/react-collapsible@1.1.2 @radix-ui/react-context-menu@2.2.4 @radix-ui/react-hover-card@1.1.4 @radix-ui/react-menubar@1.1.4 @radix-ui/react-navigation-menu@1.2.3 @radix-ui/react-popover@1.1.4 @radix-ui/react-progress@1.1.1 @radix-ui/react-radio-group@1.2.2 @radix-ui/react-scroll-area@1.2.2 @radix-ui/react-slider@1.2.2 @radix-ui/react-tabs@1.1.2 @radix-ui/react-toggle@1.1.1 @radix-ui/react-toggle-group@1.1.1 vaul@^0.9.9
```

