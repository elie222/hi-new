import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { INVITE_TTL_MS } from "../context";
import type { Db } from "../db/client";
import { groupInvites, groupMembers, groups } from "../db/schema";
import { randomToken } from "./tokens";

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
): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    // One reusable link per group. Lock the group so replacing a link cannot
    // race a join or another replacement.
    await tx.execute(sql`select ${groups.id} from ${groups} where ${groups.id} = ${groupId} for update`);
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
    await tx.insert(groupInvites).values({ token, groupId, creatorId, expiresAt, label });
    return { token, expiresAt };
  });
}

// A group owned by `ownerId`, with its reusable invite.
export async function createGroup(db: Db, ownerId: number, name: string, firstLabel: string | null = null) {
  const publicId = randomToken("hng");
  const [created] = await db
    .insert(groups)
    .values({ publicId, name, ownerId })
    .returning({ id: groups.id, createdAt: groups.createdAt });
  await db.insert(groupMembers).values({ groupId: created!.id, handleId: ownerId, role: "owner" });
  const invite = await createGroupInvite(db, created!.id, ownerId, firstLabel);
  return { id: created!.id, publicId, name, createdAt: created!.createdAt, invite };
}
