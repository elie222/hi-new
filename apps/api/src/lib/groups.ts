import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { INVITE_TTL_MS } from "../context";
import type { Db } from "../db/client";
import { groupInvites, groupMembers, groups, handles } from "../db/schema";
import { randomToken, sha256Hex } from "./tokens";
import { sealSecret } from "./secret-box";

export function groupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export async function createGroupInvite(
  db: Db,
  groupId: number,
  creatorId: number,
  label: string | null = null,
  encryptionKey?: string,
): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    // One reusable link per group. Lock the group so replacing a link cannot
    // race a join or another replacement.
    await tx.execute(
      sql`select ${groups.id} from ${groups} where ${groups.id} = ${groupId} for update`,
    );
    const now = new Date();
    await tx
      .update(groupInvites)
      .set({ expiresAt: now })
      .where(
        and(
          eq(groupInvites.groupId, groupId),
          isNull(groupInvites.redeemedAt),
          gt(groupInvites.expiresAt, now),
        ),
      );
    const token = randomToken("hngi", 16);
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    await tx.insert(groupInvites).values({
      token: await sha256Hex(token),
      tokenEnc: encryptionKey
        ? await sealSecret(encryptionKey, `group-invite:${groupId}`, token)
        : null,
      groupId,
      creatorId,
      expiresAt,
      label,
    });
    return { token, expiresAt };
  });
}

// A group owned by `ownerId`, with its reusable invite.
export async function createGroup(
  db: Db,
  ownerId: number,
  name: string,
  firstLabel: string | null = null,
  encryptionKey?: string,
) {
  return db.transaction(async (tx) => {
    const publicId = randomToken("hng");
    const [owner] = await tx
      .select({ publicKey: handles.publicKey })
      .from(handles)
      .where(eq(handles.id, ownerId));
    if (!owner) throw new Error("Group owner not found");
    const [created] = await tx
      .insert(groups)
      .values({ publicId, name, ownerId })
      .returning({ id: groups.id, createdAt: groups.createdAt });
    await tx.insert(groupMembers).values({
      groupId: created!.id,
      handleId: ownerId,
      role: "owner",
      pinnedKey: owner.publicKey,
    });
    const invite = await createGroupInvite(
      tx as unknown as Db,
      created!.id,
      ownerId,
      firstLabel,
      encryptionKey,
    );
    return { id: created!.id, publicId, name, createdAt: created!.createdAt, invite };
  });
}
