#!/usr/bin/env node

/**
 * This script helps set up and start MailCrab for local development
 * It checks if Docker is available and then starts MailCrab
 */

import { exec, spawn } from 'node:child_process'
import * as readline from 'node:readline'

const MAILCRAB_PORT_SMTP = 1025
const MAILCRAB_PORT_UI = 1080
const DOCKER_IMAGE = 'marlonb/mailcrab'

// Colors for console output
const colors = {
  reset: '\x1B[0m',
  bright: '\x1B[1m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  cyan: '\x1B[36m',
}

// Print banner
console.log(`${colors.bright}${colors.blue}
 _   _                        _ _ 
| | | |                      (_) |
| | | |_ __   ___ _ __ ___  __ _| |
| | | | '_ \\ / _ \\ '_ \` _ \\/ _\` | |
| |_| | | | |  __/ | | | | | (_| | |
 \\___/|_| |_|\\___|_| |_| |_|\\__,_|_|
                                   
${colors.cyan}MailCrab Setup Tool${colors.reset}
`)

// Check if Docker is installed
function checkDocker() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.yellow}Checking if Docker is installed...${colors.reset}`)

    exec('docker --version', (error, stdout) => {
      if (error) {
        console.log(`${colors.red}❌ Docker is not installed or not in PATH${colors.reset}`)
        console.log(`${colors.yellow}Please install Docker from https://www.docker.com/get-started${colors.reset}`)
        reject(new Error('Docker not found'))
        return
      }

      console.log(`${colors.green}✅ Docker is installed: ${stdout.trim()}${colors.reset}`)
      resolve()
    })
  })
}

// Check if ports are available
function checkPorts() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.yellow}Checking if ports ${MAILCRAB_PORT_SMTP} and ${MAILCRAB_PORT_UI} are available...${colors.reset}`)

    const netstat = process.platform === 'win32'
      ? 'netstat -ano | findstr'
      : 'lsof -i'

    exec(`${netstat} :${MAILCRAB_PORT_SMTP}`, (error, stdout) => {
      const smtpInUse = !error && stdout.trim() !== ''

      exec(`${netstat} :${MAILCRAB_PORT_UI}`, (error, stdout) => {
        const uiInUse = !error && stdout.trim() !== ''

        if (smtpInUse || uiInUse) {
          const portsInUse = []
          if (smtpInUse)
            portsInUse.push(MAILCRAB_PORT_SMTP)
          if (uiInUse)
            portsInUse.push(MAILCRAB_PORT_UI)

          console.log(`${colors.red}❌ Port(s) ${portsInUse.join(', ')} already in use${colors.reset}`)

          const confirmChoice = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          })

          confirmChoice.question(`${colors.yellow}Do you want to continue anyway? (y/N): ${colors.reset}`, (answer) => {
            confirmChoice.close()

            if (answer.toLowerCase() === 'y') {
              console.log(`${colors.yellow}Continuing despite port conflicts...${colors.reset}`)
              resolve()
            }
            else {
              reject(new Error('Ports in use'))
            }
          })
        }
        else {
          console.log(`${colors.green}✅ Ports are available${colors.reset}`)
          resolve()
        }
      })
    })
  })
}

// Check if MailCrab image is pulled
function checkMailCrabImage() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.yellow}Checking if MailCrab image is available...${colors.reset}`)

    exec(`docker images ${DOCKER_IMAGE} --format "{{.Repository}}"`, (error, stdout) => {
      if (error || stdout.trim() === '') {
        console.log(`${colors.yellow}MailCrab image not found, pulling now...${colors.reset}`)

        const pull = spawn('docker', ['pull', DOCKER_IMAGE], { stdio: 'inherit' })

        pull.on('close', (code) => {
          if (code === 0) {
            console.log(`${colors.green}✅ MailCrab image pulled successfully${colors.reset}`)
            resolve()
          }
          else {
            console.log(`${colors.red}❌ Failed to pull MailCrab image${colors.reset}`)
            reject(new Error('Failed to pull image'))
          }
        })
      }
      else {
        console.log(`${colors.green}✅ MailCrab image found${colors.reset}`)
        resolve()
      }
    })
  })
}

// Check if MailCrab is already running or exists
function checkExistingContainers() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.yellow}Checking if MailCrab container exists...${colors.reset}`)

    // First check for running containers with the MailCrab image
    exec(`docker ps --filter ancestor=${DOCKER_IMAGE} --format "{{.ID}}"`, (error, stdout) => {
      if (error) {
        reject(new Error('Failed to check running containers'))
        return
      }

      const runningContainerId = stdout.trim()

      if (runningContainerId) {
        console.log(`${colors.yellow}MailCrab is already running with container ID: ${runningContainerId}${colors.reset}`)

        const confirmChoice = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        confirmChoice.question(`${colors.yellow}Do you want to stop it and start a new instance? (y/N): ${colors.reset}`, (answer) => {
          confirmChoice.close()

          if (answer.toLowerCase() === 'y') {
            exec(`docker stop ${runningContainerId}`, (error) => {
              if (error) {
                console.log(`${colors.red}❌ Failed to stop MailCrab container: ${error.message}${colors.reset}`)
                reject(error)
                return
              }

              console.log(`${colors.green}✅ Stopped existing MailCrab container${colors.reset}`)
              resolve({ action: 'create-new' })
            })
          }
          else {
            console.log(`${colors.green}✅ Using existing MailCrab container${colors.reset}`)
            resolve({ action: 'use-existing' })
          }
        })
      }
      else {
        // No running container, check for stopped container with the name
        exec('docker ps -a --filter name=unemail-mailcrab --format "{{.ID}}"', (error, stdout) => {
          if (error) {
            reject(new Error('Failed to check for stopped containers'))
            return
          }

          const stoppedContainerId = stdout.trim()

          if (stoppedContainerId) {
            console.log(`${colors.yellow}Found stopped MailCrab container with ID: ${stoppedContainerId}${colors.reset}`)

            const confirmChoice = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            })

            confirmChoice.question(`${colors.yellow}Do you want to (s)tart the existing container, (r)emove it and create a new one, or (c)ancel? (s/r/c): ${colors.reset}`, (answer) => {
              confirmChoice.close()

              if (answer.toLowerCase() === 's') {
                console.log(`${colors.yellow}Starting existing MailCrab container...${colors.reset}`)

                exec(`docker start ${stoppedContainerId}`, (error) => {
                  if (error) {
                    console.log(`${colors.red}❌ Failed to start existing MailCrab container: ${error.message}${colors.reset}`)
                    reject(error)
                    return
                  }

                  console.log(`${colors.green}✅ Started existing MailCrab container${colors.reset}`)
                  resolve({ action: 'use-existing' })
                })
              }
              else if (answer.toLowerCase() === 'r') {
                console.log(`${colors.yellow}Removing existing MailCrab container...${colors.reset}`)

                exec(`docker rm ${stoppedContainerId}`, (error) => {
                  if (error) {
                    console.log(`${colors.red}❌ Failed to remove existing MailCrab container: ${error.message}${colors.reset}`)
                    reject(error)
                    return
                  }

                  console.log(`${colors.green}✅ Removed existing MailCrab container${colors.reset}`)
                  resolve({ action: 'create-new' })
                })
              }
              else {
                console.log(`${colors.yellow}Operation cancelled${colors.reset}`)
                reject(new Error('Operation cancelled'))
              }
            })
          }
          else {
            console.log(`${colors.green}✅ No MailCrab containers found${colors.reset}`)
            resolve({ action: 'create-new' })
          }
        })
      }
    })
  })
}

// Start MailCrab container
function startMailCrab() {
  return new Promise((resolve, reject) => {
    console.log(`${colors.yellow}Starting MailCrab container...${colors.reset}`)

    const docker = spawn('docker', [
      'run',
      '-d', // Run in detached mode
      '--name',
      'unemail-mailcrab',
      '-p',
      `${MAILCRAB_PORT_SMTP}:1025`,
      '-p',
      `${MAILCRAB_PORT_UI}:1080`,
      DOCKER_IMAGE,
    ])

    let output = ''

    docker.stdout.on('data', (data) => {
      output += data.toString()
    })

    docker.on('data', (data) => {
      console.log(`${colors.red}${data.toString()}${colors.reset}`)
    })

    docker.on('close', (code) => {
      if (code === 0) {
        console.log(`${colors.green}✅ MailCrab started successfully${colors.reset}`)
        console.log(`${colors.green}✅ Container ID: ${output.trim()}${colors.reset}`)
        resolve()
      }
      else {
        console.log(`${colors.red}❌ Failed to start MailCrab container${colors.reset}`)
        reject(new Error('Failed to start container'))
      }
    })
  })
}

// Show usage instructions
function showInstructions() {
  console.log(`
${colors.bright}${colors.green}MailCrab is ready for use!${colors.reset}

${colors.bright}SMTP Server:${colors.reset} localhost:${MAILCRAB_PORT_SMTP}
${colors.bright}Web Interface:${colors.reset} http://localhost:${MAILCRAB_PORT_UI}

${colors.bright}${colors.blue}Usage with unemail:${colors.reset}

${colors.cyan}import { createEmailService } from 'unemail';
import mailcrabProvider from 'unemail/providers/mailcrab';

const emailService = createEmailService({
  provider: mailcrabProvider,
  config: {
    options: {
      host: 'localhost',
      port: ${MAILCRAB_PORT_SMTP}
    }
  }
});

// Send a test email
emailService.sendEmail({
  from: { email: 'sender@example.com', name: 'Sender' },
  to: { email: 'recipient@example.com', name: 'Recipient' },
  subject: 'Test Email',
  text: 'This is a test email sent via unemail using MailCrab'
});${colors.reset}

${colors.yellow}View sent emails at:${colors.reset} http://localhost:${MAILCRAB_PORT_UI}

${colors.yellow}To stop MailCrab:${colors.reset} docker stop unemail-mailcrab
${colors.yellow}To restart MailCrab:${colors.reset} docker start unemail-mailcrab
`)
}

// Main function
async function main() {
  try {
    await checkDocker()
    await checkPorts()
    await checkMailCrabImage()

    const { action } = await checkExistingContainers()
    if (action === 'create-new') {
      await startMailCrab()
    }

    showInstructions()
  }
  catch (error) {
    console.log(`${colors.red}❌ Setup failed: ${error.message}${colors.reset}`)
    process.exit(1)
  }
}

// Run the script
main()
