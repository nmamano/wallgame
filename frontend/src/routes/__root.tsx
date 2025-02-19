import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/router-devtools";

export const Route = createRootRoute({
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
