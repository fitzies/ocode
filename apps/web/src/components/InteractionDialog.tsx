import type {
  AskUserQuestionInteractionRequest,
  GenericInteractionField,
  InteractionRequest,
  InteractionResponse,
  JsonValue,
} from "@anvil/protocol";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { ApprovalCard } from "@/components/ApprovalCard";
import { AskUserQuestion } from "@/components/AskUserQuestion";
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

function isAskUserQuestionRequest(request: InteractionRequest): request is AskUserQuestionInteractionRequest {
  return request.presentation?.type === "ask_user_question" &&
    request.presentation.schemaVersion === 1 &&
    ["input", "select", "multiSelect"].includes(request.method);
}

function requestDescription(request: InteractionRequest) {
  if (isAskUserQuestionRequest(request)) {
    if (request.method === "select") return "Choose one";
    if (request.method === "multiSelect") return "Choose any";
    return "Your answer";
  }
  if (request.method === "multiSelect") return "Select one or more options";
  if (request.method === "confirm") return "Confirmation required";
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

  if (isAskUserQuestionRequest(request)) {
    return <AskUserQuestion request={request} onRespond={onRespond} />;
  }

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
      <div className="flex justify-end gap-2" data-presentation="confirmation-card">
        <Button variant="outline" type="button" onClick={() => onRespond({ requestId: request.id, confirmed: false })}>No</Button>
        <Button type="button" onClick={() => onRespond({ requestId: request.id, confirmed: true })}>Confirm</Button>
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
        <RadioGroup className="gap-0" value={selected[0] ?? ""} onValueChange={(value) => setSelected([value])} aria-label={request.title}>
          {request.options.map((option) => (
            <Label
              className="approval-option"
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
      <div className="approval-card-actions flex justify-end border-t border-border/60 pt-3">
        <Button
          type="submit"
          size="icon-sm"
          className="approval-card-submit"
          disabled={(request.method === "select" && !selected.length) || !selectionCountValid}
          aria-label="Submit response"
          title="Submit response"
        >
          <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2.5} />
        </Button>
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

  const footer = requests.length > 1 ? (
    <div className="flex w-full items-center justify-center gap-1.5">
      <Button variant="ghost" size="icon-sm" type="button" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0} aria-label="Previous pending request">
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2.2} />
      </Button>
      <span className="flex items-center gap-1" aria-label={`${index + 1} of ${requests.length} pending requests`}>
        {requests.map((pendingRequest, requestIndex) => (
          <Button
            key={pendingRequest.id}
            type="button"
            variant="ghost"
            size="icon-xs"
            className="approval-pager-step"
            data-current={requestIndex === index || undefined}
            data-complete={requestIndex < index || undefined}
            aria-label={`Go to pending request ${requestIndex + 1}`}
            aria-current={requestIndex === index ? "step" : undefined}
            onClick={() => setIndex(requestIndex)}
          >
            <span />
          </Button>
        ))}
      </span>
      <Button variant="ghost" size="icon-sm" type="button" onClick={() => setIndex((current) => Math.min(requests.length - 1, current + 1))} disabled={index >= requests.length - 1} aria-label="Next pending request">
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2.2} />
      </Button>
    </div>
  ) : undefined;

  return (
    <section className="relative z-[5] w-full shrink-0 px-3 pb-[var(--composer-overlay-height)] sm:px-6" aria-labelledby={titleId} aria-describedby={request.message ? messageId : undefined}>
      <ApprovalCard
        eyebrow={requestDescription(request)}
        title={request.title}
        message={request.message}
        titleId={titleId}
        messageId={request.message ? messageId : undefined}
        footer={footer}
        onDismiss={() => onRespond({ requestId: request.id, cancelled: true })}
      >
        <InteractionForm key={request.id} request={request} onRespond={onRespond} />
      </ApprovalCard>
    </section>
  );
}
