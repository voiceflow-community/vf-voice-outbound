const twilio = require('twilio')
const express = require('express')
const VoiceResponse = require('twilio').twiml.VoiceResponse
const axios = require('axios')
require('dotenv').config()
const path = require('path')

// Create Express app
const app = express()
const httpPort = process.env.PORT || 4242

// Create the server with the app
const server = require('http').createServer(app)

// Add middleware to parse URL-encoded bodies (as sent by Twilio)
app.use(express.urlencoded({ extended: true }))

// Twilio Account SID and Auth Token
const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN

// Create a Twilio client
const client = twilio(accountSid, authToken)

// Function to get Voiceflow webhook details from Twilio number
async function getVoiceflowWebhookDetails(phoneNumber) {
  try {
    console.log('Fetching webhook details for phone number:', phoneNumber)
    // Get the phone number details from Twilio
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber })
    // console.log('Found Twilio numbers:', numbers)

    if (!numbers || numbers.length === 0) {
      throw new Error('Phone number not found in Twilio account')
    }

    const number = numbers[0]

    if (!number.voiceUrl) {
      throw new Error('No voice URL configured for this phone number')
    }

    // Parse the Voiceflow webhook URL
    const voiceflowUrl = new URL(number.voiceUrl)

    if (!voiceflowUrl.pathname.includes('/webhooks/')) {
      throw new Error('Invalid Voiceflow webhook URL')
    }

    // Extract webhook ID and API key
    const webhookId = voiceflowUrl.pathname.split('/webhooks/')[1].split('/')[0]
    const apiKey = voiceflowUrl.searchParams.get('authorization')

    return { webhookId, apiKey }
  } catch (error) {
    console.error('Error getting Voiceflow webhook details:', error)
    throw error
  }
}

// Get server URL from environment variables
const serverUrl = process.env.SERVER_URL

// Store call statuses
const callStatuses = new Map()
const callTimeouts = new Map() // Store timeouts for each call
const callStates = new Map() // Track call state transitions

// Root endpoint
app.get('/', (req, res) => {
  res.json({ info: 'Voiceflow Voice Outbound Demo' })
})

// Status endpoint to get call status
app.get('/status/:callId', (req, res) => {
  const callId = req.params.callId
  const status = callStatuses.get(callId)

  if (!status) {
    return res.status(404).json({ error: 'Call not found' })
  }

  res.json(status)
})

// Endpoint to handle initial TwiML response
app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse()
  const callSid = req.body.CallSid
  const answeredBy = req.body.AnsweredBy

  console.log('Voice endpoint called with:', {
    callSid,
    answeredBy,
    to: req.body.To,
    from: req.body.From,
    body: req.body,
  })

  try {
    // Handle human or unknown cases (since unknown could be a human)
    if (
      answeredBy === 'human' ||
      answeredBy === 'unknown' ||
      answeredBy === 'machine_end_silence' ||
      answeredBy === 'machine_end_other'
    ) {
      console.log('Call answered by human/unknown, fetching webhook details...')
      // Get Voiceflow webhook details from the 'from' number
      const { webhookId, apiKey } = await getVoiceflowWebhookDetails(
        req.body.From
      )

      console.log('Webhook Id:', webhookId)

      // Only redirect to Voiceflow if a human or unknown answered
      const voiceflowUrl = new URL(
        `https://runtime-api.voiceflow.com/v1/twilio/webhooks/${webhookId}/answer`
      )

      const params = new URLSearchParams({
        authorization: apiKey,
        From: req.body.To,
        To: req.body.From,
        CallSid: req.body.CallSid,
      })

      const response = await axios.get(
        `${voiceflowUrl.toString()}?${params.toString()}`
      )

      if (
        typeof response.data === 'string' &&
        response.data.includes('<?xml')
      ) {
        res.type('text/xml')
        return res.send(response.data)
      } else {
        console.error('Unexpected Voiceflow response format:', response.data)
        // Fallback TwiML if Voiceflow response is not valid
        twiml.say('Sorry, there was an error with the voice service.')
      }
    } else if (
      answeredBy === 'machine_start' ||
      answeredBy === 'machine_end_beep'
    ) {
      // Handle voicemail detection
      // You can choose to make the call hangup here, or let it continue instead
      updateCallStatus(callSid, 'machine', 'call answered by voicemail')
      twiml.hangup()
    } else {
      // For any other case (including declined calls)
      updateCallStatus(callSid, 'declined', 'call was declined or not answered')
      twiml.hangup()
    }
  } catch (error) {
    console.error('Error in voice endpoint:', error)
    updateCallStatus(callSid, 'error', error.message)
    twiml.say('Sorry, there was an error processing your call.')
    twiml.hangup()
  }

  res.type('text/xml')
  res.send(twiml.toString())
})

// Start the server
server.listen(httpPort, () => {
  console.log(`Server is running on port ${httpPort}`)
})

// Function to initiate the call
async function makeCall(toNumber, fromNumber) {
  try {
    const call = await client.calls.create({
      to: toNumber,
      from: fromNumber,
      url: `${serverUrl}/voice`,
      statusCallback: `${serverUrl}/call-status`,
      statusCallbackEvent: [
        'initiated',
        'ringing',
        'answered',
        'completed',
        'no-answer',
        'busy',
        'failed',
        'canceled',
      ],
      statusCallbackMethod: 'POST',
      timeout: 45,
      machineDetection: 'DetectMessageEnd', // Detect answering machines
      answerOnBridge: true,
      record: false, // Ensure no recording to reduce latency
      trim: 'trim-silence', // Remove silence
    })

    // Set a timeout to check if the call wasn't answered
    const timeoutDuration = 45000 // 45 seconds
    const timeout = setTimeout(() => {
      updateCallStatus(call.sid, 'no-answer', 'call was not answered (timeout)')
    }, timeoutDuration)

    callTimeouts.set(call.sid, timeout)

    console.log(`Call initiated with SID: ${call.sid}`)
    return call
  } catch (err) {
    console.error(`Error: ${err.message}`)
    throw err
  }
}

// Endpoint to initiate a call
app.get('/call', async (req, res) => {
  try {
    let { to, from } = req.query

    to = '+' + to.replace(/^\+/, '')
    from = '+' + from.replace(/^\+/, '')

    // Validate phone number
    if (
      !to ||
      !/^\+\d{10,15}$/.test(to) ||
      !from ||
      !/^\+\d{10,15}$/.test(from)
    ) {
      return res.status(400).json({
        error:
          'Invalid to or from phone number. Must be a number with 10-15 digits (e.g., 12345678912)',
      })
    }

    const call = await makeCall(to, from)

    // Initialize call status
    callStatuses.set(call.sid, {
      callSid: call.sid,
      to: call.to,
      from: call.from,
      status: call.status,
      lastUpdated: new Date().toISOString(),
      events: [
        {
          status: call.status,
          timestamp: new Date().toISOString(),
        },
      ],
    })

    res.json({
      message: 'Call initiated successfully',
      callSid: call.sid,
      to: call.to,
      from: call.from,
      status: call.status,
      statusUrl: `${serverUrl}/status/${call.sid}`,
    })
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate call',
      message: error.message,
    })
  }
})

// Update the call-status endpoint
app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid
  const status = req.body.CallStatus
  const sipResponseCode = req.body.SipResponseCode

  console.log(`Call ${callSid} status:`, status)

  // Track state transitions
  if (!callStates.has(callSid)) {
    callStates.set(callSid, { timestamps: {} })
  }
  const callState = callStates.get(callSid)
  callState.timestamps[status] = new Date()

  // Clear timeout if it exists
  const timeout = callTimeouts.get(callSid)
  if (timeout) {
    clearTimeout(timeout)
    callTimeouts.delete(callSid)
  }

  // Add more detailed status messages
  let statusMessage = status
  let modifiedStatus = status

  if (status === 'completed' || status === 'failed') {
    const ringTime = callState.timestamps['ringing']
    const inProgressTime = callState.timestamps['in-progress']
    const completedTime = new Date()

    const totalDuration = completedTime - ringTime
    const inProgressDuration = inProgressTime
      ? completedTime - inProgressTime
      : 0
    const duration = req.body.CallDuration ? parseInt(req.body.CallDuration) : 0
    const answeredBy = req.body.AnsweredBy

    // If call duration is more than 2 seconds, it was a real conversation
    if (duration > 2) {
      modifiedStatus = 'completed'
      statusMessage = 'call completed'
    } else if (
      sipResponseCode === '487' || // Request terminated
      sipResponseCode === '486' || // Busy here
      sipResponseCode === '480' || // Temporarily unavailable
      sipResponseCode === '603' || // Decline
      (duration === 0 && !answeredBy)
    ) {
      modifiedStatus = 'declined'
      statusMessage = 'call was declined'
    } else if (
      answeredBy === 'machine_end_beep' ||
      answeredBy === 'machine_end_silence' ||
      answeredBy === 'machine_end_other'
    ) {
      modifiedStatus = 'machine'
      statusMessage = 'call answered by voicemail'
    } else if (status === 'failed') {
      statusMessage = 'call failed'
    } else {
      statusMessage = 'call completed'
    }
  } else if (status === 'busy') {
    modifiedStatus = 'declined'
    statusMessage = 'line was busy'
  } else if (status === 'no-answer') {
    modifiedStatus = 'declined'
    statusMessage = 'call was not answered'
  } else if (status === 'canceled') {
    modifiedStatus = 'declined'
    statusMessage = 'call was canceled'
  }

  // Update call status
  updateCallStatus(callSid, modifiedStatus, statusMessage, {
    duration: req.body.CallDuration,
    answeredBy: req.body.AnsweredBy,
    sipCode: sipResponseCode,
  })

  // Clean up call state if call is finished
  if (
    ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)
  ) {
    callStates.delete(callSid)

    // Keep call status for a while (e.g., 1 hour) before cleaning up
    setTimeout(() => {
      callStatuses.delete(callSid)
    }, 60 * 60 * 1000)
  }

  res.sendStatus(200)
})

// Helper function to update call status
function updateCallStatus(callSid, status, message, additionalData = {}) {
  const currentStatus = callStatuses.get(callSid) || {
    callSid,
    events: [],
  }

  const statusUpdate = {
    status,
    message,
    timestamp: new Date().toISOString(),
    ...additionalData,
  }

  currentStatus.status = status
  currentStatus.lastUpdated = statusUpdate.timestamp
  currentStatus.events.push(statusUpdate)

  callStatuses.set(callSid, currentStatus)
}
