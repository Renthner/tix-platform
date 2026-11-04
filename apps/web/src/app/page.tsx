/**
 * Storefront entry. The event listing, seating chart and waiting room are implemented in
 * Phase 2; until then this route only confirms that the application shell is served.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Ticketing Platform</h1>
      <p className="text-muted-foreground">
        Die Plattform ist eingerichtet. Veranstaltungen werden nach der Konfiguration im
        Admin-Portal hier angezeigt.
      </p>
    </main>
  );
}
