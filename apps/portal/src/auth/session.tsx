import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { Member, MemberProfile, PortalInfo } from "../api/types";
import { setTimeZone } from "../lib/format";

interface PortalValue {
  /** Null when the centre does not run the portal at all (404 portal_unavailable). */
  info: PortalInfo | null;
  member: Member | null;
  loading: boolean;
  error: unknown;
  /** Stores the profile returned by sign-in, sign-up, activation or a profile change. */
  signedIn(profile: MemberProfile): void;
  signOut(): Promise<void>;
}

const PortalContext = createContext<PortalValue | null>(null);

const INFO_KEY = ["info"];
const SESSION_KEY = ["session"];

export function PortalProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const info = useQuery({
    queryKey: INFO_KEY,
    queryFn: async () => {
      try {
        return await api.get<PortalInfo>("/info");
      } catch (error) {
        if (error instanceof ApiError && error.code === "portal_unavailable") return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });
  if (info.data) setTimeZone(info.data.timezone);
  const open = info.data?.portalEnabled === true;
  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return (await api.get<MemberProfile>("/auth/session")).member;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.code === "portal_unavailable")) return null;
        throw error;
      }
    },
    enabled: open,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (session.data === null) client.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "info" });
  }, [session.data, client]);

  const primary = info.data?.colors?.primary;
  useEffect(() => {
    if (primary) document.documentElement.style.setProperty("--accent", primary);
  }, [primary]);

  const value: PortalValue = {
    info: info.data ?? null,
    member: open ? (session.data ?? null) : null,
    loading: info.isPending || (open && session.isPending),
    error: info.error ?? session.error,
    signedIn: (profile) => client.setQueryData(SESSION_KEY, profile.member),
    signOut: async () => {
      await api.post("/auth/logout");
      client.setQueryData(SESSION_KEY, null);
    },
  };
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalValue {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside PortalProvider");
  return value;
}

/** The signed-in member, for pages that are only rendered behind the sign-in guard. */
export function useMember(): Member {
  const { member } = usePortal();
  if (!member) throw new Error("useMember must be used on a signed-in page");
  return member;
}
