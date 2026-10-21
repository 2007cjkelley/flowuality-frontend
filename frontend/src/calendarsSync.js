// Keeps a GET /calendars answer from undoing a newer local view-pref write
// (notify/color), which would otherwise revert a just-clicked toggle.
//
// Two guards, both needed:
// - Request id: only the most recently sent GET /calendars may apply; an
//   older one answering late is dropped (the same guard fetchFlexEvents
//   uses).
// - Per-field write tracking: even the newest GET can carry a stale value,
//   if it was sent before a toggle or the server read it before the toggle's
//   PUT committed. For each field written locally, apply() keeps the local
//   value when the write was made after the GET was sent, or its PUT has not
//   settled yet. Otherwise the server's answer already includes it and the
//   record is dropped.
export function createCalendarsSync() {
  let latestFetch = 0;
  let writeSeq = 0;
  const writes = new Map(); // calendarId -> Map(field -> { value, seq, pending })

  return {
    // Call just before sending GET /calendars; hand the ticket to apply().
    beginFetch() {
      latestFetch += 1;
      return { id: latestFetch, writeSeqAtSend: writeSeq };
    },

    isLatest(ticket) {
      return ticket.id === latestFetch;
    },

    // Call when sending a PUT /calendars/{id}/view-prefs with `fields`;
    // call the returned function once that PUT settles (success or not).
    recordWrite(calendarId, fields) {
      writeSeq += 1;
      const seq = writeSeq;
      if (!writes.has(calendarId)) writes.set(calendarId, new Map());
      const byField = writes.get(calendarId);
      const records = Object.entries(fields).map(([field, value]) => {
        const record = { value, seq, pending: true };
        byField.set(field, record);
        return record;
      });
      return () => records.forEach((record) => { record.pending = false; });
    },

    // The fetched calendars with newer local writes laid over them, or null
    // when a newer GET /calendars has been sent since this one.
    apply(ticket, fetched) {
      if (ticket.id !== latestFetch) return null;
      return fetched.map((cal) => {
        const byField = writes.get(cal.id);
        if (!byField) return cal;
        let merged = cal;
        for (const [field, record] of byField) {
          if (record.pending || record.seq > ticket.writeSeqAtSend) {
            merged = { ...merged, [field]: record.value };
          } else {
            byField.delete(field);
          }
        }
        if (byField.size === 0) writes.delete(cal.id);
        return merged;
      });
    },
  };
}
