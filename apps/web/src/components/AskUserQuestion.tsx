import {
  type AskUserQuestionInteractionRequest,
  type AskUserQuestionMode,
  createOcodeAskUserQuestionResponse,
  type InteractionResponse,
  type JsonValue,
} from "@anvil/protocol";
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

export function askUserQuestionAnswerIsValid(
  mode: AskUserQuestionMode,
  selectedOptionIndexes: number[],
  otherSelected: boolean,
  text: string,
): boolean {
  if (mode === "text") return true;
  const validOther = otherSelected && text.trim().length > 0;
  if (mode === "single-select") {
    return (selectedOptionIndexes.length === 1 && !otherSelected) || (selectedOptionIndexes.length === 0 && validOther);
  }
  return selectedOptionIndexes.length > 0 || validOther;
}

export function buildAskUserQuestionResponseValue(
  mode: AskUserQuestionMode,
  selectedOptionIndexes: number[],
  otherSelected: boolean,
  text: string,
): JsonValue | undefined {
  if (!askUserQuestionAnswerIsValid(mode, selectedOptionIndexes, otherSelected, text)) return undefined;
  if (mode === "text") {
    return createOcodeAskUserQuestionResponse([{ type: "text", value: text }]);
  }
  const indexes = [...new Set(selectedOptionIndexes)].sort((left, right) => left - right);
  return createOcodeAskUserQuestionResponse([
    ...indexes.map((optionIndex) => ({ type: "option" as const, optionIndex })),
    ...(otherSelected ? [{ type: "other" as const, value: text.trim() }] : []),
  ]);
}

export function AskUserQuestion({
  request,
  onRespond,
}: {
  request: AskUserQuestionInteractionRequest;
  onRespond: (response: InteractionResponse) => void;
}) {
  const mode: AskUserQuestionMode = request.method === "input"
    ? "text"
    : request.method === "select" ? "single-select" : "multi-select";
  const options = request.method === "select" || request.method === "multiSelect" ? request.options : [];
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<number[]>([]);
  const [otherSelected, setOtherSelected] = useState(false);
  const [text, setText] = useState("");
  const valid = askUserQuestionAnswerIsValid(mode, selectedOptionIndexes, otherSelected, text);
  const blankOther = otherSelected && text.trim().length === 0;
  const otherLabel = request.presentation.otherLabel ?? "Other";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = buildAskUserQuestionResponseValue(mode, selectedOptionIndexes, otherSelected, text);
    if (value !== undefined) onRespond({ requestId: request.id, value });
  };

  return (
    <form className="grid gap-0" onSubmit={submit} data-presentation="ask-user-question">
      {mode === "text" && (
        <Field>
          <FieldLabel htmlFor={`ask-text-${request.id}`}>Your answer</FieldLabel>
          <Textarea
            id={`ask-text-${request.id}`}
            autoFocus
            rows={4}
            placeholder="Type your answer…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      )}

      {mode === "single-select" && (
        <FieldSet className="gap-0">
          <FieldLegend className="sr-only">Choose one answer</FieldLegend>
          <RadioGroup
            className="gap-0"
            aria-label={request.title}
            value={otherSelected ? "other" : selectedOptionIndexes.length ? `option-${selectedOptionIndexes[0]}` : ""}
            onValueChange={(value) => {
              if (value === "other") {
                setOtherSelected(true);
                setSelectedOptionIndexes([]);
              } else {
                setOtherSelected(false);
                setSelectedOptionIndexes([Number(value.slice("option-".length))]);
              }
            }}
          >
            {options.map((option, index) => (
              <Label className="approval-option" key={option.id} htmlFor={`ask-${request.id}-${option.id}`}>
                <RadioGroupItem id={`ask-${request.id}-${option.id}`} value={`option-${index}`} />
                <strong>{option.label}</strong>
              </Label>
            ))}
            <Label className="approval-option" htmlFor={`ask-${request.id}-other`}>
              <RadioGroupItem id={`ask-${request.id}-other`} value="other" />
              <strong>{otherLabel}</strong>
            </Label>
          </RadioGroup>
          {otherSelected && (
            <Field className="mt-1.5">
              <FieldLabel className="sr-only" htmlFor={`ask-other-${request.id}`}>Custom answer</FieldLabel>
              <Input
                id={`ask-other-${request.id}`}
                autoFocus
                placeholder="Type something…"
                value={text}
                aria-invalid={blankOther || undefined}
                onChange={(event) => setText(event.target.value)}
              />
              {blankOther && <FieldError>Enter a custom answer.</FieldError>}
            </Field>
          )}
        </FieldSet>
      )}

      {mode === "multi-select" && (
        <FieldSet className="gap-0">
          <FieldLegend className="sr-only">Choose one or more answers</FieldLegend>
          <div className="grid gap-0">
            {options.map((option, index) => {
              const checked = selectedOptionIndexes.includes(index);
              return (
                <Label className="approval-option" key={option.id} htmlFor={`ask-${request.id}-${option.id}`}>
                  <Checkbox
                    id={`ask-${request.id}-${option.id}`}
                    checked={checked}
                    onCheckedChange={(next) => setSelectedOptionIndexes((current) => next === true
                      ? [...current, index]
                      : current.filter((value) => value !== index))}
                  />
                  <strong>{option.label}</strong>
                </Label>
              );
            })}
            <Label className="approval-option" htmlFor={`ask-${request.id}-other`}>
              <Checkbox
                id={`ask-${request.id}-other`}
                checked={otherSelected}
                onCheckedChange={(checked) => setOtherSelected(checked === true)}
              />
              <strong>{otherLabel}</strong>
            </Label>
          </div>
          {otherSelected && (
            <Field className="mt-1.5">
              <FieldLabel className="sr-only" htmlFor={`ask-other-${request.id}`}>Custom answer</FieldLabel>
              <Input
                id={`ask-other-${request.id}`}
                placeholder="Type something…"
                value={text}
                aria-invalid={blankOther || undefined}
                onChange={(event) => setText(event.target.value)}
              />
              {blankOther && <FieldError>Enter a custom answer.</FieldError>}
            </Field>
          )}
        </FieldSet>
      )}

      <div className="approval-card-actions mt-2 flex justify-end pt-2">
        <Button
          type="submit"
          size="icon-sm"
          className="approval-card-submit"
          disabled={!valid}
          aria-label="Submit answer"
          title="Submit answer"
        >
          <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2.5} />
        </Button>
      </div>
    </form>
  );
}
