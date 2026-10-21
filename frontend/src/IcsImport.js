import { useRef, useState } from "react";
import { TriangleAlert, Import as ImportIcon } from "lucide-react";

// ICS import (2026-10-17). Two entry
// points, no preview step:
//   - a calendar's gear panel: Import opens the OS file picker, the file
//     name shows under the buttons, and the panel's own Save imports it into
//     that calendar (App.js, handleSaveCalendarConfig);
//   - New calendar -> Import (or Profile -> Shared calendars): the import
//     panel below, a left-panel mode (no modal, 2026-10-18). Its "From an
//     .ics file" button opens the picker directly; the picked file always
//     becomes a new calendar, named from the file. Calendars shared with
//     the user are listed under it (App.js passes that list as children).
// Like CalendarSharing.js, this file stays free of axios/API coupling:
// App.js passes in `onImport`, resolving to { ok, data } or
// { ok: false, message }.

const MAX_BYTES = 2 * 1024 * 1024;

// Reads a picked file: { fileName, text, calendarName } or { error }.
// calendarName is the file's X-WR-CALNAME (Google/Apple set it), else
// the file name without .ics.
export function readIcsFile(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve(null);
      return;
    }
    if (file.size > MAX_BYTES) {
      resolve({ error: "That file is too big to import (2 MB at most)." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const match = text.match(/^X-WR-CALNAME:(.*)$/m);
      const calendarName = (match ? match[1].replace(/\\([,;\\])/g, "$1").trim() : "")
        || file.name.replace(/\.ics$/i, "");
      resolve({ fileName: file.name, text, calendarName });
    };
    reader.onerror = () => resolve({ error: "Couldn't read that file." });
    reader.readAsText(file);
  });
}

// The one toast after an import: the flatten warning when there is one
// (decided 2026-10-17, D4), else the count.
export function icsImportMessage(result) {
  const count = (result.new || 0) + (result.replaced || 0);
  const flattened = (result.warnings || []).find((w) => w.includes("repeat rule"));
  if (flattened) return flattened;
  if (count === 0) return "Nothing new to import: those events are already on this calendar.";
  return `Imported ${count} ${count === 1 ? "event" : "events"}`;
}

// An Import button that opens the OS file picker directly.
export function IcsFileButton({ onPicked, testId, className = "calendar-add-choice-btn", label = "Import" }) {
  const inputRef = useRef(null);
  return (
    <>
      <button type="button" className={className} onClick={() => inputRef.current?.click()} data-testid={testId}>
        <ImportIcon size={14} /> {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".ics,text/calendar"
        className="ics-file-input-hidden"
        onChange={async (e) => {
          const picked = await readIcsFile(e.target.files && e.target.files[0]);
          e.target.value = ""; // picking the same file again still fires onChange
          if (picked) onPicked(picked);
        }}
        data-testid={`${testId}-input`}
      />
    </>
  );
}

export function IcsImportPanel({ onImport, onCancel, onDone, children }) {
  const [picked, setPicked] = useState(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);

  const handlePicked = (result) => {
    setError(result.error || null);
    if (result.error) {
      setPicked(null);
      return;
    }
    setPicked(result);
    if (!nameTouched) setName(result.calendarName);
  };

  const canImport = !!picked && !!name.trim() && !importing;

  const handleImport = async () => {
    if (!canImport) return;
    setImporting(true);
    const result = await onImport({ ics: picked.text, new_calendar_name: name.trim() });
    setImporting(false);
    if (result.ok) onDone(result.data);
    else setError(result.message);
  };

  return (
    <div className="settings-panel">
      <div className="settings-panel-scroll" data-testid="calendar-import-panel">
        <div className="form-group">
          <div className="ics-export-actions">
            <IcsFileButton onPicked={handlePicked} testId="ics-file-btn" label="From an .ics file" />
          </div>
          <div className="ics-hint">Exported from Google Calendar, Outlook, Apple Calendar or Flowuality. It becomes a new calendar.</div>
          {picked && <div className="ics-file-name" data-testid="ics-file-name">{picked.fileName}</div>}
          {error && (
            <div className="calendar-config-field-error" data-testid="ics-import-error">
              <TriangleAlert size={12} /> {error}
            </div>
          )}
        </div>
        {picked && (
          <div className="form-group">
            <label className="form-label">Name</label>
            <input
              type="text"
              className="form-input"
              placeholder="Calendar name"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              data-testid="ics-new-name-input"
            />
          </div>
        )}
        {children}
      </div>

      <div className="settings-actions">
        <button
          className="delete-btn settings-action-btn"
          onClick={onCancel}
          disabled={importing}
          data-testid="ics-import-cancel-btn"
        >
          Cancel
        </button>
        <button
          className="add-event-btn settings-action-btn"
          onClick={handleImport}
          disabled={!canImport}
          data-testid="ics-import-confirm-btn"
        >
          {importing ? "Importing…" : "Import"}
        </button>
      </div>
    </div>
  );
}
