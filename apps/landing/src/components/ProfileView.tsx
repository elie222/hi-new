import { useEffect, useState } from "react";
import { BotCard, defaultColorFor, isBotColor, shareOnXUrl, XIcon, type BotColor } from "@hi-new/ui";
import { readClaim } from "../lib/claim";

export default function ProfileView() {
  const [profile, setProfile] = useState<{ name: string; color: BotColor; isOwn: boolean; hasClaim: boolean } | null>(null);

  useEffect(() => {
    const name = location.pathname.match(/^\/([a-z0-9][a-z0-9_-]*)\/?$/i)?.[1]?.toLowerCase();
    if (!name) return void location.replace("/");
    (async () => {
      try {
        const [res, ownerRes] = await Promise.all([
          fetch("/api/handles/" + encodeURIComponent(name), { cache: "no-store" }),
          fetch("/api/owner/session?handle=" + encodeURIComponent(name), { cache: "no-store" }).catch(() => null),
        ]);
        if (res.status !== 200) return void location.replace("/");
        const data = await res.json();
        const owner = ownerRes?.ok ? await ownerRes.json() : null;
        const hasClaim = readClaim()?.name === name;
        setProfile({
          name,
          color: isBotColor(data.color) ? data.color : defaultColorFor(name),
          isOwn: hasClaim || owner?.owns_handle === true,
          hasClaim,
        });
      } catch {
        location.replace("/");
      }
    })();
  }, []);

  if (!profile) return null;
  const { name } = profile;

  return (
    <main className="welcome">
      <BotCard name={name} color={profile.color} />
      <div className="claim-actions profile-own-actions">
        {profile.hasClaim ? (
          <a className="btn" href={`/${name}/setup`}>Set up your bot</a>
        ) : profile.isOwn ? (
          <a className="btn" href="/owner">Manage your bot</a>
        ) : (
          <a className="btn" href={`/?ref=${name}`}>Get your own name</a>
        )}
        {profile.isOwn && (
          <a className="btn btn-secondary x-btn" href={shareOnXUrl(name)} target="_blank" rel="noopener">
            <XIcon /> Share
          </a>
        )}
      </div>
    </main>
  );
}
