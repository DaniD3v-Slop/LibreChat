const express = require('express');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const { isEnabled, generateCheckAccess } = require('@librechat/api');
const { requireJwtAuth, configMiddleware, messageIpLimiter } = require('~/server/middleware');
const methods = require('~/models');

const { getRoleByName } = methods;

const router = express.Router();
router.use(requireJwtAuth);
router.use(configMiddleware);

const checkSchedulesAccess = generateCheckAccess({
  permissionType: PermissionTypes.SCHEDULES,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkSchedulesCreate = generateCheckAccess({
  permissionType: PermissionTypes.SCHEDULES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

const handlers = require('~/server/services/Schedules/handlers');

router.get('/', checkSchedulesAccess, handlers.listSchedules);
router.get('/:id', checkSchedulesAccess, handlers.getSchedule);
router.post('/', checkSchedulesCreate, handlers.createSchedule);
router.patch('/:id', checkSchedulesCreate, handlers.updateSchedule);
router.delete('/:id', checkSchedulesCreate, handlers.deleteSchedule);
// Run-now mutates runtime state; gate it on CREATE like the UI does (not USE).
// This is also where LIMIT_MESSAGE_IP has to apply to a manual run: the fire itself is a
// loopback POST carrying the server's address, so limiting by IP there would pool every
// user into one bucket. Here the initiating client's address is still on the request.
// The USER limiter is NOT duplicated here; the fire token carries the authenticated id,
// so the chat router applies it to the loopback exactly once.
router.post(
  '/:id/run',
  ...(isEnabled(process.env.LIMIT_MESSAGE_IP) ? [messageIpLimiter] : []),
  checkSchedulesCreate,
  handlers.runScheduleNow,
);

module.exports = router;
