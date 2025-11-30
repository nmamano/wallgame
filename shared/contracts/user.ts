export interface User {
  id: string;
  email?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  picture?: string | null;
}

export interface MeResponse {
  user: User | null;
}
