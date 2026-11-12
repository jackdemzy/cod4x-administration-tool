// Block 21 (4.18.27): capture -> change -> verify, and on failure rollback from the point.
// A rollback that fails marks the subject RECOVERY_REQUIRED; nothing on it starts until a restore.
const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };

export async function guardedChange({ store, subject, action, actor = null, manual = false, capture, change, verify, rollback, audit = () => {} }) {
  if (await store.recovery(subject)) fail('RECOVERY_REQUIRED', { subject });
  let pointId;
  try {
    const parts = await capture();
    ({ pointId } = await store.capture(subject, { action, actor, manual, entries: parts?.entries || [], data: parts?.data || {}, refs: parts?.refs || {}, parts: parts?.parts || [] }));
  } catch (error) {
    if (error.code === 'RESTORE_POINT_FAILED' || error.code === 'RESTORE_POINT_TOO_LARGE') throw error;
    fail('RESTORE_POINT_FAILED', { cause: error.code || null });
  }
  audit('info', 'restore_point.created', { subject, action, restorePointId: pointId });
  try {
    const result = await change();
    await verify(result);
    audit('info', 'change.verified', { subject, action, restorePointId: pointId });
    return { result, restorePointId: pointId };
  } catch (error) {
    try {
      await rollback(await store.read(subject, pointId));
    } catch (rollbackError) {
      await store.markRecovery(subject, pointId).catch(() => {});
      audit('error', 'change.rollback_failed', { subject, action, restorePointId: pointId, code: error.code || null, rollbackCode: rollbackError.code || null });
      throw Object.assign(error, { rolledBack: false, recoveryRequired: true, restorePointId: pointId });
    }
    audit('warn', 'change.rolled_back', { subject, action, restorePointId: pointId, code: error.code || null });
    throw Object.assign(error, { rolledBack: true, restorePointId: pointId });
  }
}
