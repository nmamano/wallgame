import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { type QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { SoundProvider } from "@/components/sound-provider";
import { Navigation } from "@/components/navigation";
import { Toaster } from "@/components/ui/toaster";

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: Root,
});

function Root() {
  return (
    <ThemeProvider defaultTheme="dark">
      <SoundProvider>
        <div className="min-h-screen bg-background">
          <Navigation />
          {/* Outlet loads the other routes in the routes/ dir. */}
          <Outlet />
        </div>
        <Toaster />
        {/* Can help with debugging -- don't need it right now. */}
        {/* <TanStackRouterDevtools /> */}
      </SoundProvider>
    </ThemeProvider>
  );
}
