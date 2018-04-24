const puppeteer = require('puppeteer')
const listManager = require('./shared/list-manager')
const utils = require('./shared/utils')
const program = require('commander')
const fs = require('fs')
const execSync = require('child_process').execSync
const chalk = require('chalk')

const https = require('../src/https')
const trackers = require('../src/trackers')
const surrogates = require('../src/surrogates')

let browser

program
    .option('-f, --file <name>', 'Text file with newline-separated hostnames')
    .option('-o, --output <name>', 'Output name, e.g. "test" will output files at "test-sites"')
    .option('-t, --allow-trackers', 'Don\'t run tracker blocking')
    .parse(process.argv)

const fileName = program.file
const output = program.output
const outputPath = `${output}-sites`
const allowTrackers = program.allowTrackers

const handleRequest = (requests, siteToCheck, request) => {
    let url = request.url()
    let type = request.resourceType()

    // we don't care about main frame requests
    if (type === 'document') {
        request.continue()
        return
    }

    requests.push([url, type])

    let upgradedUrl
    let tracker

    try {
        upgradedUrl = https.getUpgradedUrl(url)
    } catch (e) {
        console.log(`error getting HTTPS upgraded URL for ${url}: ${e.message}`)
    }

    if (upgradedUrl && url !== upgradedUrl) {
        url = upgradedUrl
    }

    try {
        tracker = trackers.isTracker(url, siteToCheck, type)
    } catch (e) {
        console.log(`error getting tracker for ${url}: ${e.message}`)
    }

    if (tracker && tracker.block && !allowTrackers) {
        if (tracker.redirectUrl) {
            url = tracker.redirectUrl
        } else {
            request.abort()
            return
        }
    }

    request.continue({
        url: url
    })
}

const setup = async () => {
    // load any lists and plug them into any classes that wait for them
    await listManager.loadLists()
    https.addLists(listManager.getList('https'))
    trackers.addLists({
        entityList: listManager.getList('entityList'),
        whitelist: listManager.getList('whitelist')
    })
    surrogates.addLists(listManager.getList('surrogates'))

    // set up headless browser
    browser = await puppeteer.launch({
        args: ['--no-sandbox']
    })

    execSync(`mkdir -p ${outputPath}`)
}

const teardown = async () => {
    await browser.close()
}

const refreshBrowser = async () => {
    await browser.close()

    browser = await puppeteer.launch({
        args: ['--no-sandbox']
    })
}

const getSiteData = async (siteToCheck) => {
    const page = await browser.newPage()
    const url = `http://${siteToCheck}`
    let requests = []
    let failed = false

    await page.setRequestInterception(true)
    page.on('request', handleRequest.bind(null, requests, siteToCheck))
    page.on('response', (response) => {
        if (!utils.responseIsOK(response, siteToCheck)) {
            console.log(chalk.red(`got ${response.status()} for ${response.url()}`))
            failed = true
        }
    })

    // wait for the page to load and then an extra 3s, to be sure
    try {
        await page.goto(url, { timeout: 10000, waitUntil: 'load' })
    } catch (e) {
        console.log(chalk.red(`timed out for ${url}`))
    }
    await page.waitFor(3000)
    page.removeAllListeners()
    await page.close()

    // ignore requests for failed pages (e.g. if we saw their 404 page)
    if (failed) { requests = [] }

    return { url, requests }
}

const run = async () => {
    let sites

    try {
        sites = fs.readFileSync(fileName, { encoding: 'utf8' }).trim().split('\n')
    } catch (e) {
        console.log(chalk.red(`Error getting sites from file ${fileName}: ${e.message}`))
        return
    }

    await setup()

    let sitesChecked = 0

    for (let siteToCheck of sites) {
        let failed = false

        if (sitesChecked && sitesChecked % 20 === 0) {
            console.log(`checked ${sitesChecked}, refreshing browser instance...`)
            await refreshBrowser()
        }

        let path = `${outputPath}/${siteToCheck}.json`
        let fileExists

        try {
            fileExists = fs.existsSync(path)
        } catch (e) {
            // ¯\_(ツ)_/¯
        }

        if (fileExists) {
            console.log(`dump file exists for ${siteToCheck}, skipping`)
            continue
        }

        let data = await getSiteData(siteToCheck)

        sitesChecked += 1

        if (!data.requests.length) {
            console.log(chalk.red(`couldn't get requests for ${siteToCheck}`))
            failed = true
        }

        if (failed) {
            data = { url: `http://${siteToCheck}`, failed: true }
        } else {
            console.log(chalk.green(`got ${data.requests.length} requests for ${siteToCheck}`))
        }

        fs.writeFileSync(`${outputPath}/${siteToCheck}.json`, JSON.stringify(data))
    }

    await teardown()
}

run()
