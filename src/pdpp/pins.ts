/**
 * Collection Profile connectors this CLI will install, each pinned to one
 * signed artifact digest.
 *
 * The published catalog lists every connector the data-connectors repo
 * builds, most of them untested against a real account and many sharing an
 * id with a legacy connector. Pinning follows Vana Desktop's admission list:
 * a connector appears here once it has been proven end to end, and the digest
 * is what gets verified, so a catalog update cannot change what runs.
 */
export interface PdppPin {
  /** Source id in `vana sources`, and the connector key in the registry. */
  id: string;
  name: string;
  company: string;
  description: string;
  version: string;
  digest: string;
}

export const PDPP_PINS: readonly PdppPin[] = [
  {
    id: "whoop",
    name: "WHOOP",
    company: "WHOOP",
    description:
      "Exports your WHOOP profile, body measurements, cycles, recoveries, sleeps and workouts.",
    version: "0.1.0",
    digest:
      "sha256:daafcf17033be65aac5acd6e106a3d25df370be09b8a6fdda5932ec069b0d114",
  },
];

export function findPdppPin(source: string): PdppPin | null {
  const id = source.toLowerCase();
  return PDPP_PINS.find((pin) => pin.id === id) ?? null;
}

export function pinOciReference(pin: PdppPin): string {
  return `ghcr.io/pdp-connect/connector/${pin.id}@${pin.digest}`;
}
