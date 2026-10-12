// Onyx: the signed-in person and their role, for any component that needs it.
import { createContext, useContext } from "react";
import type { Me, Role } from "./accessApi";

export type AccessState = { me: Me | null; reload: () => void };

export const AccessContext = createContext<AccessState>({ me: null, reload: () => {} });

export function useAccess(): AccessState {
  return useContext(AccessContext);
}

/** The signed-in role, or null while unknown or refused. */
export function useRole(): Role | null {
  const { me } = useAccess();
  return me?.signedIn ? me.role : null;
}
