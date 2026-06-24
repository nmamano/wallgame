import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { type QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { SoundProvider } from "@/components/sound-provider";
import { Navigation } from "@/components/navigation";
import { Toaster } from "@/components/ui/toaster";
import { useMediaQuery } from "@/hooks/use-media-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: Root,
});

function Root() {
  const router = useRouterState();
  const pathname = router.location.pathname;
  const isSmallScreen = useMediaQuery("(max-width: 1023px)");
  const isGamePage = pathname.startsWith("/game/");
  // Hide nav on mobile game pages to maximize board space
  const hideChrome = isSmallScreen && isGamePage;

  return (
    <ThemeProvider defaultTheme="dark">
      <SoundProvider>
        <div className="min-h-screen bg-background">
          {!hideChrome && <Navigation />}
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
