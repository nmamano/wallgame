import { hc } from "hono/client";
import { type ApiRoutes } from "@server/index";
import { queryOptions } from "@tanstack/react-query";

const client = hc<ApiRoutes>("/");

export const api = client.api;

export const userQueryOptions = queryOptions({
  queryKey: ["get-current-user"],
  queryFn: getCurrentUser,
  staleTime: Infinity,
});

async function getCurrentUser() {
  const res = await api.me.$get();
  if (!res.ok) {
    throw new Error(
      `Server error: Failed to fetch current user: ${res.statusText}`
    );
  }
  const data = await res.json();
  return data;
}
