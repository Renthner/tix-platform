/** Venue fields needed for a map / directions link. */
export interface MapsVenue {
  name: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** The venue's own Google Maps link (takes precedence when it is an http(s) URL). */
  mapsUrl?: string | null;
}

/**
 * Link to the venue on Google Maps (shop event page, order page, e-mails): the venue's own link,
 * else a search link from the coordinates, else from the address.
 */
export function venueMapsUrl(venue: MapsVenue): string {
  if (venue.mapsUrl && /^https?:\/\//i.test(venue.mapsUrl)) return venue.mapsUrl;
  const query =
    venue.latitude != null && venue.longitude != null
      ? `${venue.latitude},${venue.longitude}`
      : [venue.name, venue.street, venue.postalCode, venue.city, venue.country]
          .filter(Boolean)
          .join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
