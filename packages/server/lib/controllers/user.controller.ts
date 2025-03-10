import { getUserAccountAndEnvironmentFromSession } from '../utils/utils.js';
import type { Request, Response, NextFunction } from 'express';

class UserController {
    async getUser(req: Request, res: Response, next: NextFunction) {
        try {
            const user = (await getUserAccountAndEnvironmentFromSession(req)).user;

            res.status(200).send({
                user: {
                    id: user.id,
                    accountId: user.account_id,
                    email: user.email,
                    name: user.name
                }
            });
        } catch (err) {
            next(err);
        }
    }
}

export default new UserController();
