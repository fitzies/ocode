import type {
  GenericInteractionField,
  InteractionRequest,
  InteractionResponse,
  JsonValue,
} from "@anvil/protocol";
import { Icon } from "@iconify/react";
import altArrowLeftIcon from "@iconify-icons/solar/alt-arrow-left-linear";
import altArrowRightIcon from "@iconify-icons/solar/alt-arrow-right-linear";
import closeCircleIcon from "@iconify-icons/solar/close-circle-linear";
import questionCircleIcon from "@iconify-icons/solar/question-circle-bold-duotone";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

interface InteractionDialogProps {
  requests: InteractionRequest[];
  onRespond: (response: InteractionResponse) => void;
}

function requestDescription(request: InteractionRequest) {
  if (request.method === "multiSelect") return "Select one or more options";
  if (request.method === "editor") return "Edit multi-line text";
  if (request.method === "unknown") return `Extension interaction · ${request.originalMethod}`;
  return `Extension interaction · ${request.method}`;
}

function GenericFields({
  fields,
  values,
  onChange,
}: {
  fields: GenericInteractionField[];
  values: Record<string, JsonValue>;
  onChange: (id: string, value: JsonValue) => void;
}) {
  return fields.map((field) => {
    if (field.type === "boolean") {
      return (
        <label className="dialog-check" key={field.id}>
          <input type="checkbox" checked={values[field.id] === true} onChange={(event) => onChange(field.id, event.target.checked)} />
          <span>{field.label}</span>
        </label>
      );
    }
    if (field.type === "select") {
      return (
        <label className="dialog-field" key={field.id}>
          <span>{field.label}</span>
          <select required={field.required} value={String(values[field.id] ?? "")} onChange={(event) => onChange(field.id, event.target.value)}>
            <option value="">Choose…</option>
            {field.options.map((option) => <option key={option.id} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      );
    }
    if (field.type === "multiSelect") {
      const selected = Array.isArray(values[field.id]) ? values[field.id] as JsonValue[] : [];
      return (
        <fieldset className="dialog-fieldset" key={field.id}>
          <legend>{field.label}</legend>
          {field.options.map((option) => (
            <label className="dialog-check" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) => onChange(field.id, event.target.checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    if (field.type !== "text" && field.type !== "textarea") return null;
    const Field = field.type === "textarea" ? "textarea" : "input";
    return (
      <label className="dialog-field" key={field.id}>
        <span>{field.label}</span>
        <Field
          required={field.required}
          placeholder={field.placeholder}
          value={String(values[field.id] ?? "")}
          onChange={(event) => onChange(field.id, event.target.value)}
          rows={field.type === "textarea" ? 4 : undefined}
        />
      </label>
    );
  });
}

function InteractionForm({
  request,
  onRespond,
}: {
  request: InteractionRequest;
  onRespond: (response: InteractionResponse) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState(
    request.method === "editor"
      ? request.value ?? ""
      : request.method === "input"
        ? request.defaultValue ?? ""
        : "",
  );
  const initialGenericValues = useMemo(() => {
    if (request.method !== "unknown" || !request.fields) return {};
    return Object.fromEntries(
      request.fields.map((field) => [
        field.id,
        field.type === "boolean"
          ? field.defaultValue ?? false
          : field.type === "multiSelect"
            ? []
            : "defaultValue" in field
              ? field.defaultValue ?? ""
              : "",
      ]),
    ) as Record<string, JsonValue>;
  }, [request]);
  const [genericValues, setGenericValues] = useState<Record<string, JsonValue>>(initialGenericValues);
  const [genericError, setGenericError] = useState<string>();

  const cancel = () => onRespond({ requestId: request.id, cancelled: true });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.method === "select") {
      const value = selected[0];
      if (value) onRespond({ requestId: request.id, value });
      return;
    }
    if (request.method === "multiSelect") {
      if (selected.length < (request.minSelections ?? 0)) return;
      onRespond({ requestId: request.id, value: selected });
      return;
    }
    if (request.method === "input" || request.method === "editor") {
      onRespond({ requestId: request.id, value: text });
      return;
    }
    if (request.method === "unknown" && request.fields) {
      const missingRequired = request.fields.some((field) => {
        if (!("required" in field) || !field.required) return false;
        const value = genericValues[field.id];
        return value === "" || value === null || (Array.isArray(value) && value.length === 0);
      });
      if (missingRequired) {
        setGenericError("Complete every required field before submitting.");
        return;
      }
      onRespond({ requestId: request.id, value: genericValues });
    }
  };

  if (request.method === "confirm") {
    return (
      <div className="dialog-actions dialog-actions--confirm">
        <button className="dialog-button dialog-button--secondary" type="button" onClick={() => onRespond({ requestId: request.id, confirmed: false })}>No</button>
        <button className="dialog-button dialog-button--primary" type="button" onClick={() => onRespond({ requestId: request.id, confirmed: true })}>Yes, continue</button>
      </div>
    );
  }

  if (request.method === "unknown" && !request.fields) {
    return (
      <div className="unsupported-interaction">
        <strong>Anvil cannot respond to this interaction yet.</strong>
        <p>The raw request is preserved, but this terminal-only component needs an Anvil adapter.</p>
        <details><summary>Request payload</summary><pre>{JSON.stringify(request.raw, null, 2)}</pre></details>
        <div className="dialog-actions"><button className="dialog-button dialog-button--secondary" type="button" onClick={cancel}>Dismiss request</button></div>
      </div>
    );
  }

  const selectionCountValid =
    request.method !== "multiSelect" ||
    (selected.length >= (request.minSelections ?? 0) &&
      selected.length <= (request.maxSelections ?? Number.POSITIVE_INFINITY));

  return (
    <form className="interaction-form" onSubmit={submit}>
      {request.method === "select" && (
        <div className="dialog-options" role="radiogroup" aria-label={request.title}>
          {request.options.map((option) => (
            <label className="dialog-option" key={option.id}>
              <input type="radio" name={request.id} value={option.value} checked={selected[0] === option.value} onChange={() => setSelected([option.value])} />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>
          ))}
        </div>
      )}
      {request.method === "multiSelect" && (
        <fieldset className="dialog-fieldset dialog-options">
          <legend className="sr-only">{request.title}</legend>
          {request.options.map((option) => (
            <label className="dialog-option" key={option.id}>
              <input
                type="checkbox"
                value={option.value}
                checked={selected.includes(option.value)}
                disabled={!selected.includes(option.value) && selected.length >= (request.maxSelections ?? Number.POSITIVE_INFINITY)}
                onChange={(event) => setSelected(event.target.checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))}
              />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>
          ))}
          {(request.minSelections || request.maxSelections) && (
            <p className="selection-requirement">
              {request.minSelections ? `Choose at least ${request.minSelections}` : ""}
              {request.minSelections && request.maxSelections ? " and " : ""}
              {request.maxSelections ? `up to ${request.maxSelections}` : ""}
              {` · ${selected.length} selected`}
            </p>
          )}
        </fieldset>
      )}
      {request.method === "input" && (
        <label className="dialog-field"><span>Response</span><input autoFocus placeholder={request.placeholder} value={text} onChange={(event) => setText(event.target.value)} /></label>
      )}
      {request.method === "editor" && (
        <label className="dialog-field"><span>Content</span><textarea autoFocus rows={8} value={text} onChange={(event) => setText(event.target.value)} /></label>
      )}
      {request.method === "unknown" && request.fields && (
        <GenericFields fields={request.fields} values={genericValues} onChange={(id, value) => {
          setGenericError(undefined);
          setGenericValues((current) => ({ ...current, [id]: value }));
        }} />
      )}
      {genericError && <p className="dialog-form-error" role="alert">{genericError}</p>}
      <div className="dialog-actions">
        <button className="dialog-button dialog-button--secondary" type="button" onClick={cancel}>Cancel</button>
        <button className="dialog-button dialog-button--primary" type="submit" disabled={(request.method === "select" && !selected.length) || !selectionCountValid || (request.method === "multiSelect" && selected.length > (request.maxSelections ?? Number.POSITIVE_INFINITY))}>Submit response</button>
      </div>
    </form>
  );
}

export function InteractionDialog({ requests, onRespond }: InteractionDialogProps) {
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const request = requests[Math.min(index, requests.length - 1)];

  useEffect(() => setIndex((current) => Math.min(current, Math.max(0, requests.length - 1))), [requests.length]);

  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex='-1'])") ?? []);
    requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onRespond({ requestId: request.id, cancelled: true });
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [request, onRespond]);

  if (!request) return null;

  return (
    <div className="dialog-backdrop">
      <div ref={dialogRef} className="interaction-dialog" role="dialog" aria-modal="true" aria-labelledby="interaction-title" aria-describedby={request.message ? "interaction-message" : undefined}>
        <header className="interaction-dialog-header">
          <span className="dialog-symbol"><Icon icon={questionCircleIcon} width={20} /></span>
          <span className="dialog-heading-copy">
            <small>{requestDescription(request)}</small>
            <h2 id="interaction-title">{request.title}</h2>
          </span>
          <button className="icon-button" type="button" aria-label="Cancel interaction" onClick={() => onRespond({ requestId: request.id, cancelled: true })}><Icon icon={closeCircleIcon} width={19} /></button>
        </header>
        {request.message && <p className="interaction-message" id="interaction-message">{request.message}</p>}
        <div className="interaction-dialog-body"><InteractionForm key={request.id} request={request} onRespond={onRespond} /></div>
        {requests.length > 1 && (
          <footer className="dialog-queue-nav">
            <button type="button" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0} aria-label="Previous pending request"><Icon icon={altArrowLeftIcon} width={15} /></button>
            <span>{index + 1} of {requests.length} pending</span>
            <button type="button" onClick={() => setIndex((current) => Math.min(requests.length - 1, current + 1))} disabled={index >= requests.length - 1} aria-label="Next pending request"><Icon icon={altArrowRightIcon} width={15} /></button>
          </footer>
        )}
      </div>
    </div>
  );
}
