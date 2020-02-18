const fs = require('fs')
const path = require('path')
const Twit = require('twit')
const got = require('got')
const makeDir = require('make-dir')

const DROPBOX_TOKEN = ''
const SAVE_PATH = ''
const DROPBOX_ROOT = ''

const TWITTER_OPTION = {
  consumer_key: '',
  consumer_secret: '',
  access_token: '',
  access_token_secret: '',
}

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

  await makeDir(path.resolve(SAVE_PATH, profile))
  const filePath = path.resolve(SAVE_PATH, profile, filename)
  try {
    await fs.promises.access(filePath, fs.constants.F_OK)
  } catch (e) {
    return {
      profile,
      filename,
      url,
    }
  }
  return null
}

function saveFile (file) {
  const dropboxOption = {
    headers: {
      'Authorization': `Bearer ${DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ close: true }),
      'Content-Type': 'application/octet-stream',
    },
    retry: 20,
  }
  const filePath = path.resolve(SAVE_PATH, file.profile, file.filename)
  const filePath2 = path.resolve(SAVE_PATH, file.filename)
  const stream = got.stream(file.url)

  const endpoint = 'https://content.dropboxapi.com/2/files/upload_session/start'
  const fStream = fs.createWriteStream(filePath)
  const fStream2 = fs.createWriteStream(filePath2)
  const dStream = got.stream.post(endpoint, dropboxOption)
  const dStream2 = got.stream.post(endpoint, dropboxOption)

  stream.pipe(fStream)
  stream.pipe(fStream2)
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
        console.error(`${file.profile}/${file.filename}`)
        fs.unlink(filePath, () => {})
        fs.unlink(filePath2, () => {})
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
            path: `${DROPBOX_ROOT}/${profile
              ? file.profile + '/'
              : ''}${file.filename}`,
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

  return Promise.all([a, b])
}

async function main () {
  const twit = new Twit(TWITTER_OPTION)

  const twits = await twit.get('statuses/home_timeline', {
    tweet_mode: 'extended',
    count: 100,
  })
  const data = twits.data

  const medias = data.
    filter((_) => (_).extended_entities).
    map((_) => (_).extended_entities.media).
    flatMap((_) => _)

  const files = (await Promise.all(medias.map(getFiles))).filter((_) => _)
  // const files = require('./files')
  const entries = (await Promise.allSettled(files.map(saveFile))).
    flatMap((_) => _).
    filter((entry) => entry.status === 'fulfilled').
    map((entry) => entry.value).
    flatMap((_) => _)
  const result = await got.post(
    'https://api.dropboxapi.com/2/files/upload_session/finish_batch', {
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entries }),
    })
  console.log(result.body)
}

(async () => {
  try {
    await main()
  } catch (e) {
    console.log(e)
  }
})()
