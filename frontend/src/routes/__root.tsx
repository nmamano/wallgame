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
          <div className="bg-amber-600 text-white text-center py-2 px-4 text-sm">
            🚧 In development.{" "}
            <a
              href="https://nilmamano.com/blog/wall-game-intro"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-100"
            >
              Learn more
            </a>
            {" · "}
            <a
              href="https://wallwars.net"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-100"
            >
              Old site
            </a>
          </div>
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
