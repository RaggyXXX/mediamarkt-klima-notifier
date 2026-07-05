// =====================================================================
//  geo.mjs — PLZ -> Koordinaten (gebuendelte Tabelle) + Distanz.
//  Kein externer Dienst, kein DB-Zugriff: alles in-RAM.
//  (Gespiegelt nach web/lib/geo.mjs — bei Aenderung beide anpassen.)
// =====================================================================
import PLZ from './plz-coords.mjs';

/** PLZ (5-stellig) -> { lat, lon } oder null. */
export function plzToCoords(plz) {
  const c = PLZ[String(plz || '').trim()];
  return c ? { lat: c[0], lon: c[1] } : null;
}

/** Luftlinie in km (Haversine). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = x => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Liegt Punkt b im Umkreis (km) um Punkt a? a/b = {lat,lon}. */
export function withinKm(a, b, km) {
  if (!a || !b) return false;
  return haversineKm(a.lat, a.lon, b.lat, b.lon) <= km;
}

export const plzCount = Object.keys(PLZ).length;
