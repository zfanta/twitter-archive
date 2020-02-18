require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Twit = require('twit')
const got = require('got')

const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN
const SAVE_PATH = process.env.SAVE_PATH
const DROPBOX_ROOT = process.env.DROPBOX_ROOT

const TWITTER_OPTION = {
  consumer_key: process.env.CONSUMER_KEY,
  consumer_secret: process.env.CONSUMER_SECRET,
  access_token: process.env.ACCESS_TOKEN,
  access_token_secret: process.env.ACCESS_TOKEN_SECRET,
}

let lastFiles = null

async function getFiles (media) {
  const profile = media.expanded_url.match(
    /^http?s:\/\/twitter.com\/(.*?)\//)[1]
  let filename
  let url
  if (media.type === 'video') {
    const variants = media.video_info.variants.filter((_) => _.bitrate)
    let viedo = variants[0]
    for (let i = 1; i < variants.length; i++) {
      if (viedo.bitrate < variants[i].bitrate) {
        viedo = variants[i]
      }
    }
    filename = path.basename(viedo.url)
    filename = filename.substr(0, filename.lastIndexOf('?'))
    url = viedo.url
  } else {
    filename = path.basename(media.media_url)
    url = media.media_url
  }

  if (lastFiles.has(filename)) {
    return null
  }

  return {
    profile,
    filename,
    url,
  }
}

async function saveFile (file, retry) {
  const dropboxOption = {
    headers: {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ close: true }),
      'Content-Type': 'application/octet-stream',
    },
    retry: 20,
  }
  const stream = got.stream(file.url)

  const endpoint = 'https://content.dropboxapi.com/2/files/upload_session/start'
  const dStream = got.stream.post(endpoint, dropboxOption)
  const dStream2 = got.stream.post(endpoint, dropboxOption)

  stream.pipe(dStream)
  stream.pipe(dStream2)

  let offset = 0
  stream.on('data', (data) => {
    // stream 에서 데이터 전송
    offset += data.length
  })

  function callback (stream, profile) {
    let body = ''
    stream.on('data', (data) => {
      body += data
    })
    return function (resolve, reject) {
      stream.on('error', (err) => {
        reject(err)
      })
      stream.on('end', () => {
        const response = JSON.parse(body.toString())
        resolve({
          cursor: {
            session_id: response.session_id,
            offset,
          },
          commit: {
            path: `${DROPBOX_ROOT}/${profile ? file.profile + '/' : ''}${file.filename}`,
            mode: 'add',
            autorename: true,
            mute: true,
            strict_conflict: false,
          },
        })
      })
    }
  }

  const a = new Promise(callback(dStream, false))
  const b = new Promise(callback(dStream2, true))

  try {
    return await Promise.all([a, b])
  } catch (e) {
    if (e.statusCode === 500 && 0 < retry) {
      return saveFile(file, retry - 1)
    }
    console.error(`${file.profile}/${file.filename}`)
    console.error(e)
    console.error()
    return Promise.reject(e);
  }
}

async function main () {
  const lastFilesPath = `${SAVE_PATH}/lastFiles.json`
  try {
    const content = await fs.promises.readFile(lastFilesPath)
    lastFiles = new Set(JSON.parse(content.toString()))
  } catch (e) {
    lastFiles = new Set()
  }

  const twit = new Twit(TWITTER_OPTION)

  const twits = await twit.get('statuses/home_timeline', {
    tweet_mode: 'extended',
    count: 100,
  })
  const data = twits.data

  const medias = data.filter((_) => (_).extended_entities).map((_) => (_).extended_entities.media).flatMap((_) => _)

  const files = (await Promise.all(medias.map(getFiles))).filter((_) => _)
  const entries = (await Promise.allSettled(files.map(saveFile, 10)))
    .filter((entry) => entry.status === 'fulfilled')
    .flatMap((_) => _.value)
  const result = await got.post(
    'https://api.dropboxapi.com/2/files/upload_session/finish_batch', {
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entries }),
    }
  )
  console.log(result.body)

  const succeeded = entries.map(entry => path.basename(entry.commit.path))
  lastFiles = new Set(succeeded)
  await fs.promises.writeFile(lastFilesPath, JSON.stringify(Array.from(lastFiles)))
}

(async () => {
  try {
    await main()
  } catch (e) {
    console.log(e)
  }
})()
