import { Request, Response, Router } from 'express';
import database from '../database';
import { replyData, replyError } from '../';
import auth from '../middlewares/auth';
import permissions from '../middlewares/permissions';
import { checkSchema, validationResult } from 'express-validator';
import availableLanguages from '../languages.json';
import { fetchUsers, getChannelsOf } from '../ipc-server';
import { generateGuildJWT } from '../utils/jwt';
import { createRatelimiter } from '../middlewares/ratelimiter';
import premium from '../middlewares/premium';
import { DISCORD_ID_REGEX } from '../utils/constants';

const guildsRouter = Router();

interface CompleteLeaderboardEntry {
    userID: string;
    username: string;
    discriminator: string;
    avatarURL: string;
    bonus: number;
    fake: number;
    leaves: number;
    regular: number;
}

guildsRouter.get('/:guildID/leaderboard', createRatelimiter(5, undefined, 20, true), premium, async (req, res) => {

    const guildID = req.params.guildID;
    const settings = await database.fetchGuildSettings(guildID);
    const leaderboard = await database.fetchGuildLeaderboard(guildID, settings.storageID, 20);
    const users = await fetchUsers(leaderboard.map((u) => u.userID));

    const newLeaderboard: CompleteLeaderboardEntry[] = [];

    leaderboard.forEach((value) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const user = users.find((u) => u.id === value.userID) || {
            username: 'Unknown',
            discriminator: '0000',
            avatarURL: 'https://cdn.discordapp.com/embed/avatars/0.png'
        }!;
        const entry = {
            ...value,
            username: user.username,
            discriminator: user.discriminator,
            avatarURL: user.avatarURL
        }
        newLeaderboard.push(entry);
    });

    replyData(newLeaderboard, req, res);

});

guildsRouter.get('/:guildID/jwt',  auth, createRatelimiter(5), permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const token = await database.fetchGuildAPIToken(guildID);

    return replyData({
        token
    }, req, res);

});

guildsRouter.post('/:guildID/jwt', auth, createRatelimiter(3, undefined, 1), permissions, premium, async (req, res) => {

    if (req.jwtType === 'guild') return replyError(403, 'Only user JWTs are allowed for this route.', res);
    
    const guildID = req.params.guildID;

    const newToken = generateGuildJWT(guildID);
    await database.updateGuildAPIToken(guildID, newToken, req.decodedJWT.userID, new Date());
    const token = await database.fetchGuildAPIToken(guildID);

    return replyData({
        token
    }, req, res);

});

guildsRouter.get('/:guildID/channels', auth, createRatelimiter(3, undefined, 5), permissions, premium, async (req, res) => {
    
    const guildID = req.params.guildID;
    const channels = await getChannelsOf(guildID);

    replyData(channels, req, res);
    
});

guildsRouter.get('/:guildID/settings', auth, createRatelimiter(3, undefined, 5), permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const guildSettings = await database.fetchGuildSettings(guildID);

    replyData(guildSettings, req, res);

});

guildsRouter.post('/:guildID/settings', auth, createRatelimiter(3, undefined, 5), permissions, premium, checkSchema({
    storageID: {
        in: 'body',
        isString: true,
        optional: true
    },
    prefix: {
        in: 'body',
        isString: true,
        isLength: {
            errorMessage: 'Prefix should be at least one character and 10 characters max',
            options: {
                min: 1,
                max: 10
            }
        },
        withMessage: {
            options: 'Guild prefix is not valid'
        },
        optional: true
    },
    language: {
        in: 'body',
        isString: true,
        custom: {
            options: (value) => availableLanguages.some((l) => l.name === value)
        },
        withMessage: {
            options: 'Guild language is not valid'
        },
        optional: true
    },
    cmdChannel: {
        in: 'body',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        },
        withMessage: {
            options: 'Command channel is not valid'
        },
        optional: {
            options: {
                checkFalsy: false,
                nullable: true
            }
        }
    },
    fakeThreshold: {
        in: 'body',
        isInt: {
            options: {
                gt: 0
            }
        },
        optional: {
            options: {
                nullable: true
            }
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const guildSettings = await database.fetchGuildSettings(guildID);

    if (Object.prototype.hasOwnProperty.call(req.body, 'prefix') && guildSettings.prefix !== req.body.prefix) await database.updateGuildSetting(guildID, 'prefix', req.body.prefix);
    if (Object.prototype.hasOwnProperty.call(req.body, 'language') && guildSettings.language !== req.body.language) await database.updateGuildSetting(guildID, 'language', req.body.language);
    if (Object.prototype.hasOwnProperty.call(req.body, 'cmdChannel') && guildSettings.cmdChannel !== req.body.cmdChannel) await database.updateGuildSetting(guildID, 'cmdChannel', req.body.cmdChannel);
    if (Object.prototype.hasOwnProperty.call(req.body, 'fakeThreshold') && guildSettings.fakeThreshold !== req.body.fakeThreshold) await database.updateGuildSetting(guildID, 'fakeThreshold', req.body.fakeThreshold);

    if (Object.prototype.hasOwnProperty.call(req.body, 'storageID') && guildSettings.storageID !== req.body.storageID) {
        const guildStorages = await database.fetchGuildStorages(guildID);
        if (!guildStorages.some((storage) => storage.storageID === req.body.storageID)) {
            return replyError(400, 'Storage with this ID can not be found.', res);
        } else {
            await database.updateGuildSetting(guildID, 'storageID', req.body.storageID);
        }
    }

    const newGuildSettings = await database.fetchGuildSettings(guildID);
    
    replyData(newGuildSettings, req, res);

});

guildsRouter.get('/:guildID/blacklisted', auth, permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const guildBlacklistedUsers = await database.fetchGuildBlacklistedUsers(guildID);

    replyData(guildBlacklistedUsers, req, res);

});

guildsRouter.post('/:guildID/blacklisted/:userID', auth, permissions, premium, checkSchema({
    userID: {
        in: 'params',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const userID = req.params.userID;

    const blacklistedUsers = await database.fetchGuildBlacklistedUsers(guildID);
    if (blacklistedUsers.includes(userID)) return replyError(400, 'This user is already blacklisted.', res);

    await database.addGuildBlacklistedUser({
        guildID,
        userID
    });

    const newBlacklistedUsers = await database.fetchGuildBlacklistedUsers(guildID);

    replyData(newBlacklistedUsers, req, res);

});

guildsRouter.delete('/:guildID/blacklisted/:userID', auth, permissions, premium, checkSchema({
    userID: {
        in: 'params',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const userID = req.params.userID;

    const blacklistedUsers = await database.fetchGuildBlacklistedUsers(guildID);
    if (!blacklistedUsers.includes(userID)) return replyError(400, 'This user is not blacklisted.', res);

    await database.removeGuildBlacklistedUser({
        guildID,
        userID
    });

    const newBlacklistedUsers = await database.fetchGuildBlacklistedUsers(guildID);

    replyData(newBlacklistedUsers, req, res);

});

guildsRouter.get('/:guildID/storages', auth, permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const guildStorages = await database.fetchGuildStorages(guildID);

    replyData(guildStorages, req, res);

});

guildsRouter.post('/:guildID/storages', auth, permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    await database.removeGuildInvites(guildID);

    const settings = await database.fetchGuildSettings(guildID);
    const storages = await database.fetchGuildStorages(guildID);

    replyData({
        storages,
        settings
    }, req, res);

});

guildsRouter.get('/:guildID/members/:userID', auth, permissions, premium, checkSchema({
    userID: {
        in: 'params',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const userID = req.params.userID;

    const settings = await database.fetchGuildSettings(guildID);
    const memberData = await database.fetchGuildMember({
        userID,
        guildID,
        storageID: settings.storageID
    });

    replyData(memberData, req, res);

});

guildsRouter.post('/:guildID/members/:userID', auth, permissions, premium, checkSchema({
    userID: {
        in: 'params',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    },
    number: {
        in: 'body',
        isInt: true
    },
    type: {
        in: 'body',
        isString: true,
        custom: {
            options: (value) => ['regular', 'bonus', 'fake', 'leaves'].includes(value)
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const userID = req.params.userID;

    const number = req.body.number;
    const type = req.body.type;

    const settings = await database.fetchGuildSettings(guildID);

    const memberData = await database.fetchGuildMember({
        userID,
        guildID,
        storageID: settings.storageID
    });
    if (memberData.notCreated) await database.createGuildMember({
        userID,
        guildID,
        storageID: settings.storageID
    });
    await database.addInvites({
        userID,
        guildID,
        storageID: settings.storageID,
        number,
        type
    });

    const newMemberData = await database.fetchGuildMember({
        userID,
        guildID,
        storageID: settings.storageID
    });

    replyData(newMemberData, req, res);

});

guildsRouter.get('/:guildID/members/:userID/events', auth, permissions, premium, checkSchema({
    userID: {
        in: 'params',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    }
}), async (req: Request, res: Response) => {

    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const userID = req.params.userID;

    const memberData = await database.fetchGuildMemberEvents({
        userID,
        guildID
    });

    replyData(memberData, req, res);

});

guildsRouter.get('/:guildID/plugins', auth, permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const guildPlugins = await database.fetchGuildPlugins(guildID);

    replyData(guildPlugins, req, res);

});

guildsRouter.post('/:guildID/plugins/:pluginName', auth, permissions, premium, checkSchema({
    enabled: {
        in: 'body',
        isBoolean: true
    },
    channel: {
        in: 'body',
        isString: true,
        matches: {
            options: DISCORD_ID_REGEX
        }
    },
    mainMessage: {
        in: 'body',
        isString: true,
        isLength: {
            options: { min: 1, max: 1900 }
        }
    },
    vanityMessage: {
        in: 'body',
        isString: true,
        isLength: {
            options: { min: 1, max: 1900 }
        }
    },
    oauth2Message: {
        in: 'body',
        isString: true,
        isLength: {
            options: { min: 1, max: 1900 }
        },
        optional: true
    },
    unknownMessage: {
        in: 'body',
        isString: true,
        isLength: {
            options: { min: 1, max: 1900 }
        }
    }
}), async (req: Request, res: Response) => {
    
    const err = validationResult(req);
    if (!err.isEmpty()) {
        const errors = err.mapped();
        const msg = errors[Object.keys(errors)[0]].msg;
        return replyError(400, msg, res);
    }

    const guildID = req.params.guildID;
    const pluginName = req.params.pluginName;
    
    await database.updateGuildPlugin(guildID, pluginName, {
        enabled: req.body.enabled,
        channel: req.body.channel,
        mainMessage: req.body.mainMessage,
        vanityMessage: req.body.vanityMessage,
        unknownMessage: req.body.unknownMessage,
        ...(pluginName !== 'joinDM' ? ({
            oauth2Message: req.body.oauth2Message
        }) : {})
    });

    const plugins = await database.fetchGuildPlugins(guildID);

    replyData(plugins, req, res);

});

guildsRouter.get('/:guildID/subscriptions', auth, permissions, premium, async (req, res) => {

    const guildID = req.params.guildID;
    const guildSubscriptions = await database.fetchGuildSubscriptions(guildID);

    replyData(guildSubscriptions, req, res);

});

export default guildsRouter;
