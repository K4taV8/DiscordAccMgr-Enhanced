/**
 * Forme d'une entrée de watermark, déduite de src/utils/persist.js:41
 * (`Date.now() - entry.scannedAt < ttl`). Module de types seul.
 */
export interface WatermarkEntry {
  scannedAt: number;
}
