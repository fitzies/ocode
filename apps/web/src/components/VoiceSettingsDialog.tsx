import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  deleteStoredSpeechApiKey,
  getSpeechSettings,
  loadSpeechPreferences,
  putSpeechApiKey,
  resolveSpeechPreferences,
  sanitizeSpeechError,
  saveSpeechPreferences,
  speechApiKeyForSave,
  speechSettingsRequireApiKey,
  type SpeechPreferences,
  type SpeechSettings,
} from "@/lib/speechClient";
import { useSpeech } from "./SpeechProvider";

function connectionLabel(settings?: SpeechSettings): string {
  if (settings?.keySource === "settings") return "Saved on Forge";
  if (settings?.keySource === "environment") return "Managed by environment";
  return "Not configured";
}

export function VoiceSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const speech = useSpeech();
  const [settings, setSettings] = useState<SpeechSettings>();
  const [preferences, setPreferences] = useState<SpeechPreferences>();
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<"saving" | "removing" | null>(null);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const pending = operation !== null;

  useEffect(() => {
    if (!open) {
      setApiKey("");
      return;
    }
    let active = true;
    setSettings(undefined);
    setPreferences(undefined);
    setLoading(true);
    setError(undefined);
    setAnnouncement("");
    void getSpeechSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setPreferences(resolveSpeechPreferences(next, loadSpeechPreferences()));
        if (next.keySource === null) queueMicrotask(() => apiKeyRef.current?.focus());
      })
      .catch((failure) => {
        if (active) setError(sanitizeSpeechError(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (apiKeyRef.current) apiKeyRef.current.value = "";
    };
  }, [open]);

  const requestOpenChange = (next: boolean) => {
    if (pending) return;
    if (!next) setApiKey("");
    onOpenChange(next);
  };

  const applyMutation = async (next: SpeechSettings): Promise<void> => {
    setSettings(next);
    await speech.refresh();
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !settings || !preferences) return;
    if (speechSettingsRequireApiKey(settings, apiKey)) {
      setError("Enter an OpenAI API key to enable Read aloud.");
      apiKeyRef.current?.focus();
      return;
    }

    const nextKey = speechApiKeyForSave(apiKey);
    setOperation("saving");
    setError(undefined);
    setAnnouncement("");
    try {
      const nextSettings = nextKey ? await putSpeechApiKey(nextKey) : undefined;
      saveSpeechPreferences(preferences);
      if (nextSettings) await applyMutation(nextSettings);
      else await speech.refresh();
      setApiKey("");
      setAnnouncement("Voice settings saved.");
    } catch (failure) {
      setError(sanitizeSpeechError(failure, nextKey));
    } finally {
      setOperation(null);
    }
  };

  const removeSavedKey = async () => {
    if (pending || !settings?.hasStoredKey) return;
    setOperation("removing");
    setError(undefined);
    setAnnouncement("");
    try {
      const nextSettings = await deleteStoredSpeechApiKey();
      await applyMutation(nextSettings);
      setApiKey("");
      setAnnouncement("Saved API key removed.");
    } catch (failure) {
      setError(sanitizeSpeechError(failure));
    } finally {
      setOperation(null);
    }
  };

  const selectedVoice = settings?.voices.find((option) => option.id === preferences?.voice);
  const selectedStyle = settings?.styles.find((option) => option.id === preferences?.style);
  const configured = Boolean(settings && (settings.keySource !== null || settings.hasStoredKey));

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        className="grid max-h-[min(40rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-md"
        showCloseButton={!pending}
        aria-describedby="voice-settings-description"
        onOpenAutoFocus={(event) => {
          if (settings?.keySource !== null) return;
          event.preventDefault();
          apiKeyRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader className="px-4 pb-3 pt-4 pr-12">
          <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Read aloud
          </span>
          <DialogTitle>Voice settings</DialogTitle>
          <DialogDescription id="voice-settings-description">
            Responses are sent to OpenAI only when you click Read aloud.
          </DialogDescription>
        </DialogHeader>

        <form className="min-h-0 overflow-y-auto border-t border-border/60" onSubmit={save}>
          <div className="grid gap-4 p-4">
            <div className="flex items-center justify-between gap-3" role="status" aria-live="polite">
              <div>
                <p className="font-medium">Connection</p>
                <p className="text-[0.6875rem] text-muted-foreground">
                  {settings?.keySource === "environment"
                    ? "The key must be removed administratively on Forge."
                    : settings?.hasStoredKey
                      ? "The saved key remains hidden on Forge."
                      : "Add a key to make Read aloud available."}
                </p>
              </div>
              <Badge variant={settings?.keySource ? "secondary" : "outline"}>
                {loading ? "Checking…" : connectionLabel(settings)}
              </Badge>
            </div>

            <Separator />

            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="speech-api-key">OpenAI API key</FieldLabel>
                <Input
                  ref={apiKeyRef}
                  id="speech-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setError(undefined);
                    setAnnouncement("");
                  }}
                  placeholder={configured ? "Saved key remains hidden; enter a replacement" : "sk-…"}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="speech-api-key-description"
                  aria-invalid={Boolean(error)}
                  disabled={loading || pending}
                />
                <FieldDescription id="speech-api-key-description">
                  Leave blank to keep the current key. Blank never removes it.
                </FieldDescription>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="speech-voice">Voice</FieldLabel>
                  <Select
                    value={preferences?.voice}
                    onValueChange={(voice) => preferences && setPreferences({ ...preferences, voice })}
                    disabled={loading || pending || !preferences}
                  >
                    <SelectTrigger id="speech-voice" className="w-full" aria-describedby="speech-voice-description">
                      <SelectValue placeholder="Choose a voice" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {settings?.voices.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>{voice.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription id="speech-voice-description">
                    {selectedVoice?.description ?? "Choose how responses sound."}
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="speech-style">Delivery</FieldLabel>
                  <Select
                    value={preferences?.style}
                    onValueChange={(style) => preferences && setPreferences({ ...preferences, style })}
                    disabled={loading || pending || !preferences}
                  >
                    <SelectTrigger id="speech-style" className="w-full" aria-describedby="speech-style-description">
                      <SelectValue placeholder="Choose a style" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {settings?.styles.map((style) => (
                        <SelectItem key={style.id} value={style.id}>{style.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription id="speech-style-description">
                    {selectedStyle?.description ?? "Choose the speaking style."}
                  </FieldDescription>
                </Field>
              </div>
            </FieldGroup>

            {error && <FieldError>{error}</FieldError>}
            <p className="text-[0.6875rem] text-muted-foreground" role="status" aria-live="polite">
              {announcement || "Usage safeguards are configured on Forge."}
            </p>
          </div>

          <DialogFooter className="border-t border-border/60 px-4 py-3">
            {settings?.hasStoredKey && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="mr-auto text-destructive hover:text-destructive" disabled={pending}>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Remove saved key
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent onEscapeKeyDown={(event) => pending && event.preventDefault()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove the saved API key?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Read aloud will be disabled unless Forge has an environment-managed key.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" disabled={pending} onClick={() => void removeSavedKey()}>
                      Remove key
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button type="button" variant="outline" onClick={() => requestOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={loading || pending || !settings || !preferences}>
              {operation === "saving" ? "Saving…" : operation === "removing" ? "Removing…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
