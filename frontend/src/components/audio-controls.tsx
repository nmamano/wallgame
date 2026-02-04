import { Button } from "@/components/ui/button";
import { useSound } from "@/components/sound-provider";
import { Volume2, VolumeX, Music, Music2 } from "lucide-react";

export function AudioControls() {
  const { sfxEnabled, setSfxEnabled, musicEnabled, setMusicEnabled } =
    useSound();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setSfxEnabled(!sfxEnabled)}
        title={sfxEnabled ? "Mute sound effects" : "Enable sound effects"}
      >
        {sfxEnabled ? (
          <Volume2 className="h-4 w-4" />
        ) : (
          <VolumeX className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMusicEnabled(!musicEnabled)}
        title={musicEnabled ? "Mute music" : "Enable music"}
      >
        {musicEnabled ? (
          <Music className="h-4 w-4" />
        ) : (
          <Music2 className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
    </>
  );
}
