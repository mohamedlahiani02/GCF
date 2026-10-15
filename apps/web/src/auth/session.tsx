import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, ApiError } from "../api/client";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "secretariat" | "accountant";
}

interface Session {
  user: SessionUser;
  permissions: string[];
}

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  can(permission: string): boolean;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** How often the page renews the session while it is open (the server's idle limit is 30 minutes). */
const RENEW_EVERY_MS = 5 * 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await api.get<Session>("/auth/session");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: RENEW_EVERY_MS,
    refetchInterval: RENEW_EVERY_MS,
    refetchOnWindowFocus: true,
  });
  const session = query.data ?? null;

  useEffect(() => {
    if (query.data === null) client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
  }, [query.data, client]);

  const value: SessionContextValue = {
    session,
    loading: query.isPending,
    can: (permission) => !!session?.permissions.includes(permission),
    refresh: async () => {
      await query.refetch();
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
