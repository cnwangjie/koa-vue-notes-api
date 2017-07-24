import pool from '../src/db'
import joi from 'joi'
import rand from 'randexp'
import bcrypt from 'bcrypt'
import jsonwebtoken from 'jsonwebtoken'
import {} from 'dotenv/config'

import dateFormat from 'date-fns/format'
import dateAddMonths from 'date-fns/add_months'
import dateCompareAsc from 'date-fns/compare_asc'
const sgMail = require('@sendgrid/mail')

const userSchemaSignup = joi.object({
    firstName: joi.string().min(1).max(25).alphanum().required(),
    lastName: joi.string().min(1).max(25).alphanum().required(),
    username: joi.string().min(3).max(100).regex(/[a-zA-Z0-9@]/).required(),
    email: joi.string().email().required(),
    password: joi.string().min(8).max(35).required(),
})

const userSchemaAuthenticate = joi.object({
    username: joi.string().required(),
    password: joi.string().min(8).max(35).required(),
})

class User {
    constructor() {}

    async signup(ctx) {
        //First do validation on the input
        const validator = joi.validate(ctx.request.body, userSchemaSignup)
        if (validator.error) { ctx.throw(404, validator.error.details[0].message) }

        //Now let's check for a duplicate username
        var count = await pool.query(`SELECT COUNT(id) as count FROM koa_vue_notes_users WHERE username = ?`, ctx.request.body.username)
        if (count[0].count) { ctx.throw(404, 'DUPLICATE_USERNAME') }

        //And now for a duplicate email
        var count = await pool.query(`SELECT COUNT(id) as count FROM koa_vue_notes_users WHERE email = ?`, ctx.request.body.email)
        if (count[0].count) { ctx.throw(401, 'DUPLICATE_EMAIL') }

        //Now let's generate a token for this user
        ctx.request.body.token = await this.generateToken()

        //Ok now let's has their password.
        try {
            ctx.request.body.password = await bcrypt.hash(ctx.request.body.password, 12)
        } catch (error) {
            ctx.throw(400, error)
        }

        //Let's grab their ipaddress
        ctx.request.body.ip_address = ctx.request.ip

        //Ok, at this point we can sign them up.
        try {
            let result = await pool.query(`INSERT INTO koa_vue_notes_users SET ?`, ctx.request.body)

            //Let's send a welcome email.
            //TODO

            //And return our response.
            ctx.body = {'id': result.insertId}
        } catch (error) {
            ctx.throw(400, error)
        }
    }

    async authenticate(ctx) {
        const validator = joi.validate(ctx.request.body, userSchemaAuthenticate)
        if (validator.error) { ctx.throw(404, validator.error.details[0].message) }

        //Let's find that user
        let userData = await pool.query(`SELECT id, token, username, email, password FROM koa_vue_notes_users WHERE username = ?`, ctx.request.body.username)
        if (!userData.length) { ctx.throw(401, 'INVALID_CREDENTIALS') }

        //Now let's check the password
        try {
            let correct = await bcrypt.compare(ctx.request.body.password, userData[0].password)
            if (!correct) { ctx.throw(400, 'INVALID_CREDENTIALS') }
        } catch (error) {
            ctx.throw(400, error)
        }

        //Let's get rid of that password now for security reasons
        delete userData[0].password

        //Generate the refreshToken data
        let refreshTokenData = {
            'username': userData[0].username,
            'refreshToken': new rand(/[a-zA-Z0-9_-]{64,64}/).gen(),
            'info': ctx.userAgent.os + ' ' + ctx.userAgent.platform + ' ' + ctx.userAgent.browser,
            'ipAddress': ctx.request.ip,
            'expiration': dateAddMonths(new Date(), 1)
        }

        //Insert the refresh data into the db
        try {
            await pool.query(`INSERT INTO koa_vue_notes_refresh_tokens SET ?`, refreshTokenData)
        } catch (error) {
            ctx.throw(400, error)
        }

        //Ok, they've made it, send them their jsonwebtoken with their data, accessToken and refreshToken
        const token = jsonwebtoken.sign({ data: userData }, process.env.JWT_SECRET, {expiresIn: '10m'})
        ctx.body = {'access_token': token, 'refreshToken': refreshTokenData.refreshToken}
    }

    async refreshAccessToken(ctx) {
        if (!ctx.request.body.username || !ctx.request.body.refreshToken) ctx.throw(401, 'NO_REFRESH_TOKEN')

        //Let's find that user and refreshToken in the refreshToken table
        var refreshTokenData = await pool.query(`SELECT username, refreshToken, expiration FROM koa_vue_notes_refresh_tokens WHERE (username = ? AND refreshToken = ? AND isValid = 1)`, [ctx.request.body.username, ctx.request.body.refreshToken])
        if (!refreshTokenData.length) { ctx.throw(404, 'INVALID_REFRESH_TOKEN') }

        //Let's make sure the refreshToken is not expired
        var refreshTokenIsValid = dateCompareAsc(dateFormat(new Date(), 'YYYY-MM-DD HH:mm:ss'), refreshTokenData[0].expiration);
        if (refreshTokenIsValid !== -1) { ctx.throw(404, 'REFRESH_TOKEN_EXPIRED') }

        //Ok, everthing checked out. So let's invalidate the refresh token they just confirmed, and get them
        //hooked up with a new one.




        // //Ok, they've sent a valid username and refreshTokn. So let's get them all
        // //hooked up with a new accessToken and refreshToken and make sure to update the datebase
        // //while we're at it.
        // let refreshTokenData = {
        //     'refreshToken': new rand(/[a-zA-Z0-9_-]{64,64}/).gen(),
        //     'refreshTokenInfo': ctx.userAgent.os + ' ' + ctx.userAgent.platform + ' ' + ctx.userAgent.browser,
        //     'refreshTokenCreatedAt': dateFormat(new Date(), 'YYYY-MM-DD HH:mm:ss')
        // }

        // //Insert the refresh data into the db
        // try {
        //     await pool.query(`UPDATE koa_vue_notes_users SET ? WHERE id = ?`, [refreshTokenData, result[0].id])
        // } catch (error) {
        //     ctx.throw(400, error)
        // }

        // //Ok, they've made it, send them their jsonwebtoken with their data, accessToken and refreshToken
        // const token = jsonwebtoken.sign({ data: result }, process.env.JWT_SECRET, {expiresIn: '10m'})
        // ctx.body = {'access_token': token, 'refreshToken': refreshTokenData.refreshToken}
    }

    async private(ctx) {
        ctx.body = {'message': ctx.state.user}
    }

    //Helpers
    async generateToken() {
        let token = new rand(/[a-zA-Z0-9_-]{7,7}/).gen()

        if (await this.checkToken(token)) {
            await this.generateToken()
        } else {
            return token
        }
    }

    async checkToken(token) {
        let result = await pool.query(`SELECT COUNT(id) as count FROM koa_vue_notes_users WHERE token = ?`, token)
        if (result[0].count) { return true }
    }

    getJwtToken(ctx) {
        if (!ctx.header || !ctx.header.authorization) {
            return
        }

        const parts = ctx.header.authorization.split(' ')

        if (parts.length === 2) {
            const scheme = parts[0]
            const credentials = parts[1]

            if (/^Bearer$/i.test(scheme)) {
                return credentials
            }
        }
        return ctx.throw(401, 'AUTHENTICATION_ERROR')
    }


    async getAllUsers(ctx) {
        try {
            let result = await pool.query(`SELECT * FROM koa_vue_notes_users`)
            ctx.body = result
        } catch (error) {
            ctx.throw(400, error)
        }
    }

    async getUser(ctx) {
        if (!ctx.request.query.id) { ctx.throw(400, error) }


        // try {
        //     let result = await pool.query(`SELECT * FROM koa_vue_notes_users`)
        //     ctx.body = result
        // } catch (error) {
        //     console.log(error)
        //     ctx.throw(400, error)
        // }
    }
}

module.exports = User