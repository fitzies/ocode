import type {
  GenericInteractionField,
  InteractionRequest,
  InteractionResponse,
  JsonValue,
} from "@anvil/protocol";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface InteractionPanelProps {
  requests: InteractionRequest[];
  onRespond: (response: InteractionResponse) => void;
}

export function selectionCountIsValid(count: number, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  return count >= minimum && count <= maximum;
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
  return (
    <FieldGroup>
      {fields.map((field) => {
        if (field.type === "boolean") {
          return (
            <Field key={field.id} orientation="horizontal">
              <Checkbox
                id={`generic-${field.id}`}
                checked={values[field.id] === true}
                onCheckedChange={(checked) => onChange(field.id, checked === true)}
              />
              <FieldLabel htmlFor={`generic-${field.id}`}>{field.label}</FieldLabel>
            </Field>
          );
        }
        if (field.type === "select") {
          return (
            <Field key={field.id}>
              <FieldLabel>{field.label}</FieldLabel>
              <Select
                required={field.required}
                value={String(values[field.id] ?? "")}
                onValueChange={(value) => onChange(field.id, value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option.id} value={String(option.value)}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          );
        }
        if (field.type === "multiSelect") {
          const selected = Array.isArray(values[field.id]) ? values[field.id] as JsonValue[] : [];
          return (
            <FieldSet className="gap-2" key={field.id}>
              <FieldLabel>{field.label}</FieldLabel>
              <div className="grid gap-1.5">
                {field.options.map((option) => {
                  const checked = selected.includes(option.value);
                  return (
                    <Label
                      className="min-h-8 rounded-md border border-border bg-input/20 px-2.5 py-1.5 hover:bg-accent/60"
                      key={option.id}
                      htmlFor={`generic-${field.id}-${option.id}`}
                    >
                      <Checkbox
                        id={`generic-${field.id}-${option.id}`}
                        checked={checked}
                        onCheckedChange={(next) => onChange(
                          field.id,
                          next === true
                            ? [...selected, option.value]
                            : selected.filter((value) => value !== option.value),
                        )}
                      />
                      {option.label}
                    </Label>
                  );
                })}
              </div>
            </FieldSet>
          );
        }
        if (field.type !== "text" && field.type !== "textarea") return null;
        return (
          <Field key={field.id}>
            <FieldLabel htmlFor={`generic-${field.id}`}>{field.label}</FieldLabel>
            {field.type === "textarea" ? (
              <Textarea
                id={`generic-${field.id}`}
                required={field.required}
                placeholder={field.placeholder}
                value={String(values[field.id] ?? "")}
                onChange={(event) => onChange(field.id, event.target.value)}
                rows={4}
              />
            ) : (
              <Input
                id={`generic-${field.id}`}
                required={field.required}
                placeholder={field.placeholder}
                value={String(values[field.id] ?? "")}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            )}
          </Field>
        );
      })}
    </FieldGroup>
  );
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
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" type="button" onClick={() => onRespond({ requestId: request.id, confirmed: false })}>No</Button>
        <Button type="button" onClick={() => onRespond({ requestId: request.id, confirmed: true })}>Yes, continue</Button>
      </div>
    );
  }

  if (request.method === "unknown" && !request.fields) {
    return (
      <div className="grid gap-2">
        <strong className="text-destructive">ocode cannot respond to this interaction yet.</strong>
        <p className="m-0 text-muted-foreground">The raw request is preserved, but this terminal-only component needs an ocode adapter.</p>
        <details>
          <summary className="cursor-pointer text-muted-foreground">Request payload</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 font-mono text-[0.6875rem]">{JSON.stringify(request.raw, null, 2)}</pre>
        </details>
        <div className="flex justify-end"><Button variant="outline" type="button" onClick={cancel}>Dismiss request</Button></div>
      </div>
    );
  }

  const selectionCountValid = request.method !== "multiSelect" || selectionCountIsValid(
    selected.length,
    request.minSelections,
    request.maxSelections,
  );
  const selectionRequirementId = `selection-requirement-${request.id}`;

  return (
    <form className="grid gap-4" onSubmit={submit}>
      {request.method === "select" && (
        <RadioGroup value={selected[0] ?? ""} onValueChange={(value) => setSelected([value])} aria-label={request.title}>
          {request.options.map((option) => (
            <Label
              className="grid min-h-12 cursor-pointer grid-cols-[auto_1fr] items-center rounded-lg border border-border bg-input/20 px-3 py-2.5 hover:bg-accent/60 has-data-[state=checked]:border-foreground/25 has-data-[state=checked]:bg-accent"
              key={option.id}
              htmlFor={`${request.id}-${option.id}`}
            >
              <RadioGroupItem id={`${request.id}-${option.id}`} value={option.value} />
              <span className="grid gap-0.5">
                <strong className="font-medium">{option.label}</strong>
                {option.description && <small className="text-muted-foreground">{option.description}</small>}
              </span>
            </Label>
          ))}
        </RadioGroup>
      )}
      {request.method === "multiSelect" && (
        <Field>
          <Combobox
            items={request.options.map((option) => option.value)}
            multiple
            value={selected}
            onValueChange={setSelected}
          >
            <ComboboxChips aria-invalid={!selectionCountValid || undefined}>
              <ComboboxValue>
                {selected.map((value) => (
                  <ComboboxChip key={value}>
                    {request.options.find((option) => option.value === value)?.label ?? value}
                  </ComboboxChip>
                ))}
              </ComboboxValue>
              <ComboboxChipsInput
                placeholder="Search and select…"
                aria-label={request.title}
                aria-describedby={(request.minSelections || request.maxSelections) ? selectionRequirementId : undefined}
                aria-invalid={!selectionCountValid || undefined}
              />
            </ComboboxChips>
            <ComboboxContent>
              <ComboboxEmpty>No matching options.</ComboboxEmpty>
              <ComboboxList>
                {(value) => {
                  const option = request.options.find((candidate) => candidate.value === value);
                  const atMaximum = selected.length >= (request.maxSelections ?? Number.POSITIVE_INFINITY);
                  return (
                    <ComboboxItem
                      key={value}
                      value={value}
                      disabled={atMaximum && !selected.includes(value)}
                    >
                      <span className="grid pr-6">
                        <span>{option?.label ?? value}</span>
                        {option?.description && <small className="text-muted-foreground">{option.description}</small>}
                      </span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          {(request.minSelections || request.maxSelections) && (
            <FieldDescription id={selectionRequirementId} aria-live="polite">
              {request.minSelections ? `Choose at least ${request.minSelections}` : ""}
              {request.minSelections && request.maxSelections ? " and " : ""}
              {request.maxSelections ? `up to ${request.maxSelections}` : ""}
              {` · ${selected.length} selected`}
            </FieldDescription>
          )}
        </Field>
      )}
      {request.method === "input" && (
        <Field>
          <FieldLabel htmlFor={`response-${request.id}`}>Response</FieldLabel>
          <Input id={`response-${request.id}`} autoFocus placeholder={request.placeholder} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
      )}
      {request.method === "editor" && (
        <Field>
          <FieldLabel htmlFor={`response-${request.id}`}>Content</FieldLabel>
          <Textarea id={`response-${request.id}`} autoFocus rows={8} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
      )}
      {request.method === "unknown" && request.fields && (
        <GenericFields fields={request.fields} values={genericValues} onChange={(id, value) => {
          setGenericError(undefined);
          setGenericValues((current) => ({ ...current, [id]: value }));
        }} />
      )}
      {genericError && <FieldError role="alert">{genericError}</FieldError>}
      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" type="button" onClick={cancel}>Cancel</Button>
        <Button type="submit" disabled={(request.method === "select" && !selected.length) || !selectionCountValid}>Submit response</Button>
      </div>
    </form>
  );
}

export function InteractionPanel({ requests, onRespond }: InteractionPanelProps) {
  const [index, setIndex] = useState(0);
  const request = requests[Math.min(index, requests.length - 1)];

  useEffect(() => setIndex((current) => Math.min(current, Math.max(0, requests.length - 1))), [requests.length]);

  if (!request) return null;
  const titleId = `interaction-title-${request.id}`;
  const messageId = `interaction-message-${request.id}`;

  return (
    <section className="w-full shrink-0 px-3 sm:px-6" aria-labelledby={titleId} aria-describedby={request.message ? messageId : undefined}>
      <div className="mx-auto max-h-[min(32rem,54dvh)] w-full max-w-[49rem] overflow-auto rounded-xl border border-amber-500/20 bg-card text-card-foreground shadow-lg">
        <header className="sticky top-0 z-10 flex min-h-16 items-center gap-3 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <small className="block truncate font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground">
              {requestDescription(request)} · this thread
            </small>
            <h2 className="truncate text-sm font-medium" id={titleId}>{request.title}</h2>
          </span>
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Cancel interaction" onClick={() => onRespond({ requestId: request.id, cancelled: true })}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </header>
        {request.message && <p className="m-0 px-4 pt-4 text-xs/relaxed text-muted-foreground" id={messageId}>{request.message}</p>}
        <div className="p-4"><InteractionForm key={request.id} request={request} onRespond={onRespond} /></div>
        {requests.length > 1 && (
          <footer className="sticky bottom-0 grid min-h-10 grid-cols-[2rem_1fr_2rem] items-center border-t border-border bg-card/95 px-3 text-center text-[0.6875rem] text-muted-foreground backdrop-blur">
            <Button variant="ghost" size="icon-sm" type="button" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0} aria-label="Previous pending request">
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
            </Button>
            <span>{index + 1} of {requests.length} pending in this thread</span>
            <Button variant="ghost" size="icon-sm" className="justify-self-end" type="button" onClick={() => setIndex((current) => Math.min(requests.length - 1, current + 1))} disabled={index >= requests.length - 1} aria-label="Next pending request">
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
            </Button>
          </footer>
        )}
      </div>
    </section>
  );
}
