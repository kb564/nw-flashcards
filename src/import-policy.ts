export type LockedImportMode = "deck" | "backup";

export function lockedImportModes(hasStoredVault: boolean): readonly LockedImportMode[] {
  return hasStoredVault ? ["backup"] : ["deck", "backup"];
}
