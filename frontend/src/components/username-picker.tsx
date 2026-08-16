import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Asks a player who has never named themselves to pick a name before they
 * continue. Accounts are created with a generated name, and players were not
 * finding the settings page to change it.
 *
 * Mounted once, app-wide, from the root route, so it covers whichever page the
 * player lands on after signing in.
 */
export function UsernamePickerGate() {
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const { hasChosenDisplayName } = useSettings(isLoggedIn, userPending);

  // `=== false` on purpose, never `!hasChosenDisplayName`. The value is
  // undefined whenever the answer is not known - logged out, auth settling,
  // settings still loading, or the settings request failed - and only a
  // successful load can produce a real false. Treating "unknown" as "has not
  // chosen" would put this undismissable dialog in front of every logged-in
  // player the moment that request failed.
  if (hasChosenDisplayName !== false) {
    return null;
  }

  return <UsernamePicker />;
}

/**
 * Split from the gate so that it cannot mount before the settings load has
 * succeeded. Its own `useSettings` instance therefore starts from settled data,
 * and the hook's display-name sync cannot arrive later and overwrite what the
 * player is typing.
 */
function UsernamePicker() {
  // True by construction: the gate renders this only once it has a logged-in
  // player and a loaded settings response.
  const {
    displayName,
    setDisplayName,
    displayNameError,
    displayNameValidationError,
    handleChangeDisplayName,
    canChangeName,
    isSavingName,
  } = useSettings(true, false);

  // Start empty rather than pre-filled with the generated name, so choosing a
  // real one is the easy path instead of keeping the assigned one.
  useEffect(() => {
    setDisplayName("");
  }, [setDisplayName]);

  // The mount-time clear above already differs from the stored name, so the
  // hook's real-time validation starts failing before the player has done
  // anything. Hold that message back until they have touched the field or
  // tried to submit; server errors (displayNameError) show regardless.
  const [touched, setTouched] = useState(false);

  const error =
    (touched ? displayNameValidationError : null) ?? displayNameError;

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Choose your name</DialogTitle>
          <DialogDescription>
            This is how other players will see you. You can change it later in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (canChangeName && !isSavingName) {
              handleChangeDisplayName();
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="username-picker-name">Your name</Label>
            <Input
              id="username-picker-name"
              autoFocus
              value={displayName}
              onChange={(event) => {
                setTouched(true);
                setDisplayName(event.target.value);
              }}
              onBlur={() => setTouched(true)}
              placeholder="Enter a name"
              className="bg-background"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={!canChangeName || isSavingName}
          >
            {isSavingName ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
