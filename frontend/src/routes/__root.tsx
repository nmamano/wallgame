import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { type QueryClient } from "@tanstack/react-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: Root,
});

function NavBar() {
  return (
    <div className="p-2 flex gap-2">
      <Link to="/" className="[&.active]:font-bold">
        Home
      </Link>{" "}
      <Link to="/about" className="[&.active]:font-bold">
        About
      </Link>
      <Link to="/puzzles" className="[&.active]:font-bold">
        Puzzles
      </Link>
      <Link to="/profile" className="[&.active]:font-bold">
        Profile
      </Link>
      <a href="/blog" className="[&.active]:font-bold">
        Blog
      </a>
    </div>
  );
}

function Root() {
  return (
    <>
      <NavBar />
      <hr />
      {/* Outlet loads the other routes in the routes/ dir. */}
      <Outlet />
      {/* Can help with debugging -- don't need it right now. */}
      {/* <TanStackRouterDevtools /> */}
    </>
  );
}
